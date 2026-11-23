"""Synthetic reliability checks: backup restore and account/session safety.

No Yandex SDK credentials, no network calls, no real user data.
"""
import hashlib
import unittest
from datetime import datetime, timezone

from backend import backup
from backend.security import hash_password
from backend.service import DomainError, Service, disable_account
from backend.store import Account
from fake_store import FakeStore
from test_worklog import snapshot

NOW = int(datetime(2026, 11, 23, 10, 0, tzinfo=timezone.utc).timestamp())
PASSWORD = "synthetic qa password 2026"
ADMIN_EMAIL = "qa-admin@example.test"
STAFF_EMAIL = "qa-staff@example.test"


class MemoryObjects:
    def __init__(self):
        self.objects = {}

    def write(self, key, data):
        if key in self.objects:
            raise AssertionError("backup object unexpectedly overwritten")
        self.objects[key] = data

    def read(self, key, max_bytes):
        payload = self.objects[key]
        if len(payload) > max_bytes:
            raise AssertionError("backup object exceeds test bound")
        return payload


class ReliabilityRestoreTest(unittest.TestCase):
    def setUp(self):
        self.source = FakeStore()
        self.target = FakeStore()
        self.objects = MemoryObjects()
        self.service = Service(self.source, clock=lambda: NOW)
        self.source.run_write(lambda tx: tx.insert_account(
            Account("synthetic-admin", ADMIN_EMAIL, hash_password(PASSWORD),
                    "admin", True, NOW, 0)
        ))
        admin_auth = self.service.login(ADMIN_EMAIL, PASSWORD, "192.0.2.10")
        self.admin = self.service.authenticate(admin_auth["accessToken"])
        invitation = self.service.create_invite(self.admin)
        self.staff_auth = self.service.register(STAFF_EMAIL, PASSWORD, invitation["code"])
        self.staff_uid = self.staff_auth["user"]["uid"]
        self.staff = self.service.authenticate(self.staff_auth["accessToken"])

    def export(self):
        return backup.export_snapshot(
            self.source, self.objects,
            clock=lambda: datetime.fromtimestamp(NOW, tz=timezone.utc),
        )

    def restore(self, manifest):
        return backup.restore_snapshot(self.target, self.objects, manifest, confirm_isolated=True)

    def test_disabled_employee_stays_disabled_after_restore_and_cannot_sign_in(self):
        original = snapshot("3")
        self.service.put_worklog(self.staff, original, 0, "qa-first")
        disable_account(self.source, self.staff_uid, clock=lambda: NOW)
        before = self.source.run_read(lambda tx: tx.get_account(self.staff_uid))
        self.assertFalse(before.enabled)

        manifest = self.export()
        self.restore(manifest)
        account, worklog = self.target.run_read(
            lambda tx: (tx.get_account(self.staff_uid), tx.get_worklog(self.staff_uid))
        )
        self.assertFalse(account.enabled)
        self.assertEqual(account.role, "employee")
        self.assertEqual(account.session_generation, before.session_generation)
        self.assertEqual((worklog.revision, worklog.data), (1, original))

        recovered = Service(self.target, clock=lambda: NOW)
        with self.assertRaises(DomainError) as old_session:
            recovered.authenticate(self.staff_auth["accessToken"])
        self.assertEqual((old_session.exception.code, old_session.exception.status),
                         ("invalid_session", 401))
        with self.assertRaises(DomainError) as denied_login:
            recovered.login(STAFF_EMAIL, PASSWORD, "192.0.2.20")
        self.assertEqual(denied_login.exception.code, "invalid_credentials")

        admin_login = recovered.login(ADMIN_EMAIL, PASSWORD, "192.0.2.21")
        admin = recovered.authenticate(admin_login["accessToken"])
        self.assertNotIn(self.staff_uid, recovered.list_employees(admin)["users"])
        with self.assertRaises(DomainError) as hidden:
            recovered.get_employee(admin, self.staff_uid)
        self.assertEqual(hidden.exception.status, 404)

    def test_restored_mutations_do_not_revert_a_newer_server_revision(self):
        first_data = snapshot("2")
        second_data = snapshot("3")
        first_result = self.service.put_worklog(self.staff, first_data, 0, "qa-first")
        self.service.put_worklog(self.staff, second_data, 1, "qa-second")
        self.restore(self.export())

        recovered = Service(self.target, clock=lambda: NOW)
        login = recovered.login(STAFF_EMAIL, PASSWORD, "192.0.2.30")
        principal = recovered.authenticate(login["accessToken"])
        self.assertEqual(recovered.put_worklog(principal, first_data, 0, "qa-first"), first_result)
        with self.assertRaises(DomainError) as stale:
            recovered.put_worklog(principal, snapshot("4"), 0, "qa-stale")
        self.assertEqual((stale.exception.code, stale.exception.status), ("stale_revision", 409))
        self.assertEqual(recovered.get_worklog(principal),
                         {"data": second_data, "revision": 2})

    def test_corrupted_shift_is_rejected_atomically_even_with_new_checksum(self):
        data = snapshot("3")
        self.service.put_worklog(self.staff, data, 0, "qa-first")
        manifest = self.export()
        key = manifest["data_key"]
        before = self.objects.objects[key]
        self.assertIn(b'"hours":"3"', before)
        altered = before.replace(b'"hours":"3"', b'"hours":"999999"', 1)
        self.objects.objects[key] = altered
        manifest["sha256"] = hashlib.sha256(altered).hexdigest()
        with self.assertRaises(backup.BackupError):
            self.restore(manifest)
        self.assertTrue(all(not rows for rows in self.target.records.values()))
        self.assertEqual(self.service.get_worklog(self.staff),
                         {"data": data, "revision": 1})


if __name__ == "__main__":
    unittest.main()
