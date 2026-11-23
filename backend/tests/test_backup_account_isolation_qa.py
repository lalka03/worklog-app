"""Additional synthetic restore isolation tests, with no YDB or cloud access."""
import hashlib
import json
import unittest
from datetime import datetime, timezone

from backend import backup
from backend.security import hash_password
from backend.service import DomainError, Service
from backend.store import Account
from fake_store import FakeStore
from test_worklog import snapshot

NOW = int(datetime(2026, 11, 23, 16, 0, tzinfo=timezone.utc).timestamp())
PASSWORD = "isolated synthetic-only credential"
ADMIN_EMAIL = "restore-admin@example.test"
ALICE_EMAIL = "restore-alice@example.test"
BOB_EMAIL = "restore-bob@example.test"


class MemoryObjects:
    def __init__(self):
        self.objects = {}

    def write(self, key, data):
        if key in self.objects:
            raise AssertionError("existing backup object cannot be overwritten")
        self.objects[key] = data

    def read(self, key, max_bytes):
        value = self.objects[key]
        if len(value) > max_bytes:
            raise AssertionError("oversized backup read")
        return value


class RestoreAccountIsolationTest(unittest.TestCase):
    def setUp(self):
        self.source = FakeStore()
        self.target = FakeStore()
        self.objects = MemoryObjects()
        self.source_api = Service(self.source, clock=lambda: NOW)
        self.source.run_write(lambda tx: tx.insert_account(
            Account("synthetic-admin", ADMIN_EMAIL, hash_password(PASSWORD),
                    "admin", True, NOW, 0)
        ))
        auth = self.source_api.login(ADMIN_EMAIL, PASSWORD, "192.0.2.1")
        self.admin = self.source_api.authenticate(auth["accessToken"])
        self.admin_auth = auth
        self.alice_auth = self.source_api.register(
            ALICE_EMAIL, PASSWORD, self.source_api.create_invite(self.admin)["code"]
        )
        self.bob_auth = self.source_api.register(
            BOB_EMAIL, PASSWORD, self.source_api.create_invite(self.admin)["code"]
        )
        self.alice = self.source_api.authenticate(self.alice_auth["accessToken"])
        self.bob = self.source_api.authenticate(self.bob_auth["accessToken"])

    def capture(self):
        return backup.export_snapshot(
            self.source, self.objects,
            clock=lambda: datetime.fromtimestamp(NOW, timezone.utc)
        )

    def restore(self, manifest):
        return backup.restore_snapshot(
            self.target, self.objects, manifest, confirm_isolated=True
        )

    def test_restored_employees_keep_separate_worklogs_and_mutation_scopes(self):
        a_snapshot, b_snapshot = snapshot("2"), snapshot("9")
        # The same client-generated mutation ID is legal for different users.
        a_result = self.source_api.put_worklog(self.alice, a_snapshot, 0, "same-mutation-id")
        b_result = self.source_api.put_worklog(self.bob, b_snapshot, 0, "same-mutation-id")
        self.assertEqual(a_result["revision"], 1)
        self.assertEqual(b_result["revision"], 1)

        manifest = self.capture()
        self.assertEqual(self.restore(manifest)["counts"]["worklogs"], 2)
        restored = Service(self.target, clock=lambda: NOW)
        with self.assertRaises(DomainError) as old_alice:
            restored.authenticate(self.alice_auth["accessToken"])
        self.assertEqual(old_alice.exception.code, "invalid_session")
        with self.assertRaises(DomainError) as old_bob:
            restored.renew(self.bob_auth["refreshToken"])
        self.assertEqual(old_bob.exception.code, "invalid_session")

        a_login = restored.login(ALICE_EMAIL, PASSWORD, "192.0.2.2")
        b_login = restored.login(BOB_EMAIL, PASSWORD, "192.0.2.3")
        a = restored.authenticate(a_login["accessToken"])
        b = restored.authenticate(b_login["accessToken"])
        self.assertEqual(restored.get_worklog(a), {"data": a_snapshot, "revision": 1})
        self.assertEqual(restored.get_worklog(b), {"data": b_snapshot, "revision": 1})
        self.assertEqual(restored.put_worklog(a, a_snapshot, 0, "same-mutation-id"), a_result)
        self.assertEqual(restored.put_worklog(b, b_snapshot, 0, "same-mutation-id"), b_result)

        with self.assertRaises(DomainError) as blocked:
            restored.get_employee(a, b.uid)
        self.assertEqual((blocked.exception.code, blocked.exception.status), ("forbidden", 403))
        with self.assertRaises(DomainError) as denied:
            restored.list_employees(b)
        self.assertEqual((denied.exception.code, denied.exception.status), ("forbidden", 403))

        admin_login = restored.login(ADMIN_EMAIL, PASSWORD, "192.0.2.4")
        admin = restored.authenticate(admin_login["accessToken"])
        self.assertEqual(restored.get_employee(admin, a.uid)["worklog"], a_snapshot)
        self.assertEqual(restored.get_employee(admin, b.uid)["worklog"], b_snapshot)
        self.assertEqual(len(self.target.records["mutations"]), 2)
        # Restore is isolated: source and restored objects are not shared.
        self.source_api.put_worklog(self.alice, snapshot("5"), 1, "after-backup")
        self.assertEqual(restored.get_worklog(a), {"data": a_snapshot, "revision": 1})

    def test_orphaned_worklog_is_rejected_even_if_snapshot_hash_is_recalculated(self):
        data = snapshot("3")
        self.source_api.put_worklog(self.alice, data, 0, "first-mutation")
        manifest = self.capture()
        key = manifest["data_key"]
        original = self.objects.objects[key]
        rebuilt = []
        touched = False
        for line in original.splitlines():
            table, row = json.loads(line)
            if table == "worklogs":
                row["uid"] = "nonexistent-synthetic-user"
                touched = True
            rebuilt.append(json.dumps([table, row], separators=(",", ":"), ensure_ascii=False).encode() + b"\n")
        self.assertTrue(touched)
        forged = b"".join(rebuilt)
        self.objects.objects[key] = forged
        manifest["sha256"] = hashlib.sha256(forged).hexdigest()

        with self.assertRaisesRegex(backup.BackupError, "invalid snapshot worklog linkage"):
            self.restore(manifest)
        self.assertTrue(all(not rows for rows in self.target.records.values()))
        self.assertEqual(self.source_api.get_worklog(self.alice),
                         {"data": data, "revision": 1})

    def test_duplicate_account_email_rejected_atomically_with_matching_hash(self):
        manifest = self.capture()
        key = manifest["data_key"]
        rebuilt = []
        changed = False
        for line in self.objects.objects[key].splitlines():
            table, row = json.loads(line)
            if table == "accounts" and row["email"] == BOB_EMAIL:
                row["email"] = ALICE_EMAIL
                changed = True
            rebuilt.append(json.dumps([table, row], separators=(",", ":"), ensure_ascii=False).encode() + b"\n")
        self.assertTrue(changed)
        forged = b"".join(rebuilt)
        self.objects.objects[key] = forged
        manifest["sha256"] = hashlib.sha256(forged).hexdigest()
        with self.assertRaisesRegex(backup.BackupError, "duplicate snapshot account email"):
            self.restore(manifest)
        self.assertTrue(all(not rows for rows in self.target.records.values()))
        self.assertIsNotNone(self.source.run_read(
            lambda tx: tx.get_account_by_email(BOB_EMAIL)
        ))


if __name__ == "__main__":
    unittest.main()
