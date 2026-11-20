import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from backend.security import hash_password
from backend.service import DomainError, Principal, Service
from backend.store import Account, YdbStore


ENDPOINT = os.environ.get("WORKLOG_YDB_ENDPOINT")
DATABASE = os.environ.get("WORKLOG_YDB_DATABASE")
PASSWORD = "synthetic test password"


@unittest.skipUnless(ENDPOINT and DATABASE, "requires an isolated YDB endpoint and database")
class YdbIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = YdbStore.connect(ENDPOINT, DATABASE)
        cls.addClassCleanup(cls.store.close)
        cls.service = Service(cls.store)
        uid = str(uuid4())
        email = f"owner-{uid}@example.test"
        cls.owner = Principal(uid, email, "admin")
        cls.store.run_write(lambda tx: tx.insert_account(
            Account(uid, email, hash_password(PASSWORD), "admin", True, int(time.time()), 0)
        ))

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
        reset = self.service.issue_reset(self.owner, auth["user"]["uid"])
        self.service.redeem_reset(reset["code"], "synthetic replacement password")
        with self.assertRaises(DomainError) as invalid_access:
            self.service.authenticate(rotated["accessToken"])
        self.assertEqual(invalid_access.exception.code, "invalid_session")
        with self.assertRaises(DomainError) as invalid_refresh:
            self.service.renew(rotated["refreshToken"])
        self.assertEqual(invalid_refresh.exception.code, "invalid_session")
        with self.assertRaises(DomainError) as invalid_reset:
            self.service.redeem_reset(reset["code"], PASSWORD)
        self.assertEqual(invalid_reset.exception.code, "invalid_reset")
