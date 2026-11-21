import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from threading import Barrier
from types import SimpleNamespace
from uuid import uuid4

from backend.security import hash_password
from backend.service import DomainError, Service
from backend import store as storage
from backend.store import Account, YdbStore


ENDPOINT = os.environ.get("WORKLOG_YDB_ENDPOINT")
DATABASE = os.environ.get("WORKLOG_YDB_DATABASE")
PASSWORD = "synthetic test password"


class YdbTransactionTest(unittest.TestCase):
    def test_target_with_only_recovery_records_is_not_empty(self):
        class RawTransaction:
            @contextmanager
            def execute(self, query, parameters, settings):
                rows = [{"present": 1}] if "FROM `admin_recovery`" in query else []
                yield [SimpleNamespace(rows=rows)]

        self.assertFalse(storage._YdbTransaction(RawTransaction(), None).backup_target_empty())


@unittest.skipUnless(ENDPOINT and DATABASE, "requires an isolated YDB endpoint and database")
class YdbIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = YdbStore.connect(ENDPOINT, DATABASE)
        cls.addClassCleanup(cls.store.close)
        cls.service = Service(cls.store)
        uid = str(uuid4())
        email = f"owner-{uid}@example.test"
        cls.store.run_write(lambda tx: tx.insert_account(
            Account(uid, email, hash_password(PASSWORD), "admin", True, int(time.time()), 0)
        ))
        auth = cls.service.login(email, PASSWORD, f"2001:db8::{uid[:4]}:{uid[4:8]}")
        cls.owner = cls.service.authenticate(auth["accessToken"])

    def test_recovery_record_is_replaced_by_owner_uid(self):
        uid, other_uid = str(uuid4()), str(uuid4())
        first = storage.Recovery(uid, "a" * 64, 7)
        replacement = storage.Recovery(uid, "b" * 64, 8)
        other = storage.Recovery(other_uid, "a" * 64, 1)
        self.addCleanup(self.store.run_write, lambda tx: (tx.delete_recovery(uid), tx.delete_recovery(other_uid)))
        self.store.run_write(lambda tx: tx.put_recovery(first))
        self.assertEqual(self.store.run_read(lambda tx: tx.get_recovery(uid)), first)
        self.store.run_write(lambda tx: (tx.put_recovery(replacement), tx.put_recovery(other)))
        self.assertEqual(self.store.run_read(lambda tx: tx.get_recovery(uid)), replacement)
        self.store.run_write(lambda tx: tx.delete_recovery(uid))
        self.assertIsNone(self.store.run_read(lambda tx: tx.get_recovery(uid)))
        self.assertEqual(self.store.run_read(lambda tx: tx.get_recovery(other_uid)), other)

    def test_parallel_recovery_has_one_winner_in_ydb(self):
        uid = str(uuid4())
        email = f"recovery-{uid}@example.test"
        ip = f"2001:db8::{uid[:4]}:{uid[4:8]}"
        self.store.run_write(lambda tx: tx.insert_account(
            Account(uid, email, hash_password(PASSWORD), "admin", True, int(time.time()), 0)
        ))
        auth = self.service.login(email, PASSWORD, ip)
        principal = self.service.authenticate(auth["accessToken"])
        code = self.service.issue_recovery(principal, PASSWORD)["code"]
        start = Barrier(2)
        def attempt(password):
            start.wait(timeout=5)
            try:
                self.service.redeem_recovery(email, code, password)
            except DomainError as error:
                self.assertEqual((error.code, error.status), ("invalid_recovery", 422))
                return None
            return password
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, ("synthetic new password 1", "synthetic new password 2")))
        self.assertEqual(results.count(None), 1)
        winner = next(result for result in results if result is not None)
        self.assertEqual(self.service.login(email, winner, ip)["user"]["uid"], uid)
        self.assertEqual(self.store.run_read(lambda tx: tx.get_account(uid)).session_generation, 1)
        self.assertIsNone(self.store.run_read(lambda tx: tx.get_recovery(uid)))
        with self.assertRaises(DomainError) as blocked:
            self.service.renew(auth["refreshToken"])
        self.assertEqual(blocked.exception.code, "invalid_session")

    def test_parallel_register_only_one_ydb_commit(self):
        invite = self.service.create_invite(self.owner)
        start = Barrier(2)
        emails = [f"employee-{uuid4()}@example.test" for _ in range(2)]

        def attempt(email):
            start.wait(timeout=5)
            try:
                return self.service.register(email, PASSWORD, invite["code"])
            except DomainError as error:
                self.assertEqual((error.code, error.status), ("invalid_invite", 422))
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, emails))
        self.assertEqual(sum(result is not None for result in results), 1)
        committed = self.store.run_read(lambda tx: [tx.get_account_by_email(email) for email in emails])
        self.assertEqual(sum(account is not None for account in committed), 1)
        winner = next(result for result in results if result is not None)
        loser = next(email for email in emails if email != winner["user"]["email"])
        with self.assertRaises(DomainError) as error:
            self.service.login(loser, PASSWORD, f"2001:db8::{uuid4().hex[:4]}:{uuid4().hex[:4]}")
        self.assertEqual(error.exception.code, "invalid_credentials")
        self.assertEqual(self.service.authenticate(winner["accessToken"]).uid, winner["user"]["uid"])

    def test_parallel_normalized_email_consumes_only_winner_invite(self):
        invites = [self.service.create_invite(self.owner) for _ in range(2)]
        email = f"unique-{uuid4()}@example.test"
        start = Barrier(2)

        def attempt(index):
            start.wait(timeout=5)
            try:
                address = email if index == 0 else f" {email.upper()} "
                return self.service.register(address, PASSWORD, invites[index]["code"])
            except DomainError as error:
                self.assertEqual((error.code, error.status), ("invalid_invite", 422))
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        loser = results.index(None)
        recovered = self.service.register(f"other-{uuid4()}@example.test", PASSWORD, invites[loser]["code"])
        self.assertEqual(recovered["user"]["role"], "employee")

    def test_reset_revokes_rotated_session_in_ydb(self):
        invite = self.service.create_invite(self.owner)
        email = f"reset-{uuid4()}@example.test"
        auth = self.service.register(email, PASSWORD, invite["code"])
        rotated = self.service.renew(auth["refreshToken"])
        stale_principal = self.service.authenticate(rotated["accessToken"])
        reset = self.service.issue_reset(self.owner, auth["user"]["uid"])
        self.service.redeem_reset(reset["code"], "synthetic replacement password")
        with self.assertRaises(DomainError) as blocked_read:
            self.service.get_worklog(stale_principal)
        self.assertEqual(blocked_read.exception.code, "invalid_session")
        with self.assertRaises(DomainError) as invalid_access:
            self.service.authenticate(rotated["accessToken"])
        self.assertEqual(invalid_access.exception.code, "invalid_session")
        with self.assertRaises(DomainError) as invalid_refresh:
            self.service.renew(rotated["refreshToken"])
        self.assertEqual(invalid_refresh.exception.code, "invalid_session")
        with self.assertRaises(DomainError) as invalid_reset:
            self.service.redeem_reset(reset["code"], PASSWORD)
        self.assertEqual(invalid_reset.exception.code, "invalid_reset")

    def test_two_devices_competing_for_one_revision(self):
        from test_worklog import snapshot

        invite = self.service.create_invite(self.owner)
        auth = self.service.register(f"race-{uuid4()}@example.test", PASSWORD, invite["code"])
        employee = self.service.authenticate(auth["accessToken"])
        start = Barrier(2)

        def attempt(index):
            start.wait(timeout=5)
            try:
                return self.service.put_worklog(employee, snapshot(str(index)), 0, f"device-{index}")
            except DomainError as error:
                self.assertEqual((error.code, error.status), ("stale_revision", 409))
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, (1, 2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        winner = 1 if results[0] is not None else 2
        self.assertEqual(self.service.get_worklog(employee), {"data": snapshot(str(winner)), "revision": 1})
        self.assertEqual(
            self.service.put_worklog(employee, snapshot(str(winner)), 0, f"device-{winner}"),
            results[winner - 1],
        )
