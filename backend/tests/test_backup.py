import hashlib
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from backend import backup, index
from backend.security import digest, hash_password
from backend.service import DomainError, Service
from backend.store import Account, AuditEvent
from fake_store import FakeStore
from test_worklog import snapshot


NOW = datetime(2026, 11, 20, 10, 15, tzinfo=timezone.utc)
PASSWORD = "synthetic test password"
TRIGGER = {
    "messages": [{
        "event_metadata": {"event_type": "yandex.cloud.events.serverless.triggers.TimerMessage"},
        "details": {"trigger_id": "synthetic-timer"},
    }]
}
ROOT = Path(__file__).resolve().parents[2]


class PrivateObjects:
    def __init__(self, *, fail_manifest=False):
        self.objects = {}
        self.fail_manifest = fail_manifest

    def write(self, key, data):
        if self.fail_manifest and key.endswith("/manifest.json"):
            raise OSError("confidential cloud credential")
        if key in self.objects:
            raise AssertionError("backup object unexpectedly overwritten")
        self.objects[key] = data

    def read(self, key, max_bytes):
        data = self.objects[key]
        if len(data) > max_bytes:
            raise ValueError("object too large")
        return data


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.source = FakeStore()
        self.service = Service(self.source, clock=NOW.timestamp)
        self.source.run_write(lambda tx: tx.insert_account(
            Account("owner", "owner@example.test", hash_password(PASSWORD), "admin", True, int(NOW.timestamp()), 0)
        ))
        self.owner_auth = self.service.login("owner@example.test", PASSWORD, "192.0.2.1")
        self.owner = self.service.authenticate(self.owner_auth["accessToken"])
        self.target = FakeStore()
        self.objects = PrivateObjects()

    def export(self):
        return backup.export_snapshot(self.source, self.objects, lambda: NOW)

    def test_snapshot_does_not_export_sessions(self):
        invite = self.service.create_invite(self.owner)
        auth = self.service.register("employee@example.test", PASSWORD, invite["code"])
        reset = self.service.issue_reset(self.owner, auth["user"]["uid"])
        manifest = self.export()
        combined = b"".join(self.objects.objects.values())
        self.assertTrue(manifest["data_key"].startswith("yandex-test/2026-11-20/"))
        self.assertEqual(manifest["created_at"], "2026-11-20T10:15:00Z")
        for secret in (auth["accessToken"], auth["refreshToken"], reset["code"]):
            self.assertNotIn(secret.encode(), combined)
            self.assertNotIn(digest(secret).encode(), combined)
        self.assertNotIn(PASSWORD.encode(), combined)
        self.assertNotIn(invite["code"].encode(), combined)
        self.assertEqual(list(self.objects.objects)[-1], manifest["manifest_key"])

        backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        restored = Service(self.target, clock=NOW.timestamp)
        for action, code in (
            (lambda: restored.authenticate(auth["accessToken"]), "invalid_session"),
            (lambda: restored.renew(auth["refreshToken"]), "invalid_session"),
            (lambda: restored.redeem_reset(reset["code"], PASSWORD), "invalid_reset"),
        ):
            with self.assertRaises(DomainError) as error:
                action()
            self.assertEqual(error.exception.code, code)

    def test_recovery_credential_is_never_backed_up_or_restored(self):
        code = self.service.issue_recovery(self.owner, PASSWORD)["code"]
        manifest = self.export()
        combined = b"".join(self.objects.objects.values())
        self.assertNotIn(b"admin_recovery\"", combined)
        self.assertNotIn(code.encode(), combined)
        self.assertNotIn(digest(code).encode(), combined)
        self.assertEqual(manifest["schema_version"], 1)
        self.assertEqual(manifest["counts"], {
            "accounts": 1, "invitations": 0, "worklogs": 0, "mutations": 0, "audit_events": 1,
        })
        backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        restored = Service(self.target, clock=NOW.timestamp)
        auth = restored.login(self.owner.email, PASSWORD, "192.0.2.2")
        self.assertEqual(restored.recovery_status(restored.authenticate(auth["accessToken"])), {"active": False})
        with self.assertRaises(DomainError) as error:
            restored.redeem_recovery(self.owner.email, code, "another synthetic password")
        self.assertEqual((error.exception.code, error.exception.status), ("invalid_recovery", 422))

    def test_restore_rejects_recovery_rows_even_with_a_valid_checksum(self):
        manifest = self.export()
        key = manifest["data_key"]
        self.objects.objects[key] += (
            json.dumps(["admin_recovery", {"uid": "owner", "digest": "a" * 64, "generation": 0}]).encode() + b"\n"
        )
        manifest["sha256"] = hashlib.sha256(self.objects.objects[key]).hexdigest()
        with self.assertRaisesRegex(backup.BackupError, "invalid snapshot contents"):
            backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        self.assertTrue(all(not rows for rows in self.target.records.values()))

    def test_restore_refuses_a_target_with_only_recovery_credentials(self):
        self.service.issue_recovery(self.owner, PASSWORD)
        row = self.source.run_read(lambda tx: tx.get_recovery(self.owner.uid))
        self.target.run_write(lambda tx: tx.put_recovery(row))
        with self.assertRaisesRegex(backup.BackupError, "restore target must be empty"):
            backup.restore_snapshot(self.target, self.objects, self.export(), confirm_isolated=True)
        self.assertFalse(self.target.records["accounts"])
        self.assertEqual(self.target.run_read(lambda tx: tx.get_recovery(self.owner.uid)), row)

    def test_restore_accepts_pre_recovery_schema_version_one(self):
        prefix = "yandex-test/2026-11-20/" + "a" * 32
        key = f"{prefix}/snapshot.jsonl"
        self.objects.objects[key] = (
            b'["accounts",{"uid":"legacy","email":"legacy@example.test",'
            b'"password_hash":"$argon2id$fixture","role":"admin","enabled":true,'
            b'"created_at":1700000000,"session_generation":7}]\n'
        )
        manifest = {
            "schema_version": 1, "created_at": "2026-11-20T10:15:00Z", "source_database": None,
            "data_key": key, "manifest_key": f"{prefix}/manifest.json",
            "sha256": hashlib.sha256(self.objects.objects[key]).hexdigest(),
            "counts": {"accounts": 1, "invitations": 0, "worklogs": 0, "mutations": 0, "audit_events": 0},
        }
        backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        account = self.target.run_read(lambda tx: tx.get_account_by_email("legacy@example.test"))
        self.assertEqual((account.uid, account.role, account.session_generation), ("legacy", "admin", 7))
        self.assertIsNone(self.target.run_read(lambda tx: tx.get_recovery(account.uid)))

    def test_restore_requires_isolated_target(self):
        manifest = self.export()
        with self.assertRaises(backup.BackupError):
            backup.restore_snapshot(self.target, self.objects, manifest)
        self.assertTrue(all(not rows for rows in self.target.records.values()))

    def test_restore_refuses_the_snapshot_source_even_if_empty(self):
        self.source.database = self.target.database = "/ru-central1/pilot-folder/source-db"
        manifest = self.export()
        self.assertEqual(manifest["source_database"], "/ru-central1/pilot-folder/source-db")
        with self.assertRaisesRegex(backup.BackupError, "source database"):
            backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        self.assertTrue(all(not rows for rows in self.target.records.values()))

    def test_restore_refuses_nonempty_target(self):
        self.target.run_write(lambda tx: tx.put_audit(AuditEvent("audit-id", "keep", "", "", 1)))
        with self.assertRaises(backup.BackupError):
            backup.restore_snapshot(self.target, self.objects, self.export(), confirm_isolated=True)
        self.assertEqual(self.target.records["accounts"], {})
        self.assertEqual(self.target.records["audit_events"]["audit-id"].action, "keep")

    def test_restore_never_reopens_consumed_invites(self):
        used_at_capture = self.service.create_invite(self.owner)
        self.service.register("prior@example.test", PASSWORD, used_at_capture["code"])
        used_after_capture = self.service.create_invite(self.owner)
        manifest = self.export()
        self.service.register("later@example.test", PASSWORD, used_after_capture["code"])
        backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        restored = Service(self.target, clock=NOW.timestamp)
        for invite, state in ((used_at_capture, "used"), (used_after_capture, "revoked")):
            self.assertEqual(self.target.run_read(lambda tx: tx.get_invitation_by_id(invite["id"])).state, state)
            with self.assertRaises(DomainError) as error:
                restored.register("replay@example.test", PASSWORD, invite["code"])
            self.assertEqual(error.exception.code, "invalid_invite")

    def test_corrupt_snapshot_rejected(self):
        manifest = self.export()
        self.objects.objects[manifest["data_key"]] += b"x"
        with self.assertRaisesRegex(backup.BackupError, "checksum"):
            backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        self.assertTrue(all(not rows for rows in self.target.records.values()))

    def test_restore_rejects_wrong_schema_or_counts_even_with_matching_checksum(self):
        manifest = self.export()
        for altered in ({**manifest, "schema_version": 99}, {**manifest, "counts": {**manifest["counts"], "accounts": 0}}):
            with self.assertRaises(backup.BackupError):
                backup.restore_snapshot(self.target, self.objects, altered, confirm_isolated=True)
        data = self.objects.objects[manifest["data_key"]]
        altered = manifest.copy()
        self.objects.objects[manifest["data_key"]] = data.replace(b'"role":"admin"', b'"role":"ceo"')
        altered["sha256"] = hashlib.sha256(self.objects.objects[manifest["data_key"]]).hexdigest()
        with self.assertRaises(backup.BackupError):
            backup.restore_snapshot(self.target, self.objects, altered, confirm_isolated=True)
        self.assertTrue(all(not rows for rows in self.target.records.values()))

    def test_restore_roles_and_worklogs_preserved(self):
        invite = self.service.create_invite(self.owner)
        auth = self.service.register("employee@example.test", PASSWORD, invite["code"])
        employee = self.service.authenticate(auth["accessToken"])
        records = snapshot("7.5")
        saved = self.service.put_worklog(employee, records, 0, "local-mutation")
        manifest = self.export()
        result = backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)
        self.assertEqual(result["counts"]["accounts"], 2)
        restored = Service(self.target, clock=NOW.timestamp)
        for state in (self.owner, employee):
            email = self.source.run_read(lambda tx: tx.get_account(state.uid).email)
            result = restored.login(email, PASSWORD, "192.0.2.2")
            self.assertEqual(result["user"]["role"], state.role)
        login = restored.login("employee@example.test", PASSWORD, "192.0.2.3")
        restored_employee = restored.authenticate(login["accessToken"])
        self.assertEqual(restored.get_worklog(restored_employee), {"data": records, "revision": 1})
        self.assertEqual(restored.put_worklog(restored_employee, records, 0, "local-mutation"), saved)

    def test_backup_failure_reported(self):
        objects = PrivateObjects(fail_manifest=True)
        env = {
            "WORKLOG_BACKUP_TRIGGER_ID": "synthetic-timer",
            "WORKLOG_BACKUP_BUCKET": "synthetic-bucket",
            "WORKLOG_BACKUP_KMS_KEY_ID": "synthetic-kms-key",
            "WORKLOG_YDB_ENDPOINT": "grpcs://synthetic",
            "WORKLOG_YDB_DATABASE": "/synthetic",
        }
        with patch.dict("os.environ", env), patch.object(backup, "ObjectStorage", return_value=objects), \
             patch.object(backup.YdbStore, "connect", return_value=self.source), patch.object(self.source, "close", create=True):
            with self.assertLogs("backend.backup", "ERROR") as logs, self.assertRaisesRegex(backup.BackupError, "failed"):
                backup.handler(TRIGGER, SimpleNamespace(token={"access_token": "synthetic"}))
        self.assertEqual(len(objects.objects), 1)
        self.assertTrue(next(iter(objects.objects)).endswith("/snapshot.jsonl"))
        self.assertNotIn("confidential cloud credential", str(logs.output))

    def test_backup_handler_rejects_http_and_other_triggers(self):
        event = {"httpMethod": "POST", **TRIGGER}
        other_trigger = {"messages": [{"event_metadata": TRIGGER["messages"][0]["event_metadata"],
                                      "details": {"trigger_id": "other-timer"}}]}
        with patch.dict("os.environ", {"WORKLOG_BACKUP_TRIGGER_ID": "synthetic-timer"}), \
             patch.object(backup.YdbStore, "connect", side_effect=AssertionError("touched database")):
            for rejected in (event, other_trigger, {}):
                with self.assertRaises(backup.BackupError):
                    backup.handler(rejected, None)

    def test_backup_not_exposed_through_application_gateway(self):
        gateway = (ROOT / "cloud/gateway.yaml").read_text()
        paths = {line.strip().rstrip(":") for line in gateway.splitlines() if line.startswith("  /")}
        self.assertTrue(paths)
        self.assertFalse(any("backup" in path or "restore" in path or "{proxy" in path for path in paths))
        self.assertEqual(index.handler({"version": "2.0", "requestContext": {"http": {"method": "POST"}}, "rawPath": "/backup"}, None)["statusCode"], 404)

    def test_retention_config_30_days(self):
        rules = json.loads((ROOT / "cloud/backup-lifecycle.json").read_text())["Rules"]
        self.assertEqual(len(rules), 1)
        self.assertEqual(rules[0]["Status"], "Enabled")
        self.assertEqual(rules[0]["Filter"], {"Prefix": "yandex-test/"})
        self.assertEqual(rules[0]["Expiration"], {"Days": 30})
