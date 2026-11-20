import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from functools import partial
from threading import Barrier, Event

from backend.security import new_token
from backend.service import DomainError, Service, promote_owner, seed_owner_invite
from backend.store import Account
from fake_store import FakeStore, seed_test_session


PASSWORD = "sample password 123"
NEW_PASSWORD = "another password 456"
ADMIN_UID = "c9f13edf-0425-4ffd-a486-6d5695775dd8"


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.now = 1_800_000_000
        self.store = FakeStore()
        self.service = Service(self.store, clock=lambda: self.now)
        # The owner role is seeded by a privileged fixture, outside the public API.
        self.owner_account = Account(ADMIN_UID, "owner@example.test", "unused-by-fixture", "admin", True, self.now, 0)
        self.store.run_write(lambda tx: tx.insert_account(self.owner_account))
        self.owner = self.service.authenticate(seed_test_session(self.store, self.owner_account, self.now))

    def assert_error(self, code, status, fn, *args):
        with self.assertRaises(DomainError) as error:
            fn(*args)
        self.assertEqual((error.exception.code, error.exception.status), (code, status))

    def register_employee(self, email="employee@example.test", password=PASSWORD):
        code = self.service.create_invite(self.owner)["code"]
        return self.service.register(email, password, code)

    def test_register_consumes_invite(self):
        invite = self.service.create_invite(self.owner)
        auth = self.service.register("  Employee@Example.TEST  ", PASSWORD, invite["code"])
        principal = self.service.authenticate(auth["accessToken"])
        self.assertEqual(principal.email, "employee@example.test")
        self.assertEqual(principal.uid, auth["user"]["uid"])
        self.assert_error("invalid_invite", 422, self.service.register,
                          "second@example.test", PASSWORD, invite["code"])
        self.assertEqual(self.service.list_invites(self.owner)["invites"][0]["state"], "used")

    def test_parallel_register_only_one_wins(self):
        invite = self.service.create_invite(self.owner)
        start = Barrier(2)

        def attempt(email):
            start.wait(timeout=5)
            try:
                return self.service.register(email, PASSWORD, invite["code"])
            except DomainError as error:
                self.assertEqual((error.code, error.status), ("invalid_invite", 422))
                return None

        emails = ("parallel-one@example.test", "parallel-two@example.test")
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, emails))
        self.assertEqual(sum(result is not None for result in results), 1)
        winner = next(result for result in results if result is not None)
        loser = next(email for email in emails if email != winner["user"]["email"])
        self.assert_error("invalid_credentials", 401, self.service.login, loser, PASSWORD, "192.0.2.1")
        self.assertEqual(self.service.authenticate(winner["accessToken"]).email, winner["user"]["email"])

    def test_duplicate_email_preserves_invite(self):
        self.register_employee()
        invite = self.service.create_invite(self.owner)
        self.assert_error("invalid_invite", 422, self.service.register,
                          "  EMPLOYEE@EXAMPLE.TEST ", PASSWORD, invite["code"])
        result = self.service.register("alternate@example.test", PASSWORD, invite["code"])
        self.assertEqual(result["user"]["email"], "alternate@example.test")

    def test_expired_and_revoked_invites(self):
        expired = self.service.create_invite(self.owner)
        self.now += 7 * 24 * 60 * 60
        self.owner = self.service.authenticate(seed_test_session(self.store, self.owner_account, self.now))
        revoked = self.service.create_invite(self.owner)
        self.service.revoke_invite(self.owner, revoked["id"])
        for result in (expired, revoked):
            with self.subTest(invite=result["id"]):
                self.assert_error("invalid_invite", 422, self.service.register,
                                  "employee@example.test", PASSWORD, result["code"])
        states = {row["id"]: row["state"] for row in self.service.list_invites(self.owner)["invites"]}
        self.assertEqual(states, {expired["id"]: "expired", revoked["id"]: "revoked"})

    def test_worker_cannot_create_invite(self):
        auth = self.register_employee()
        employee = self.service.authenticate(auth["accessToken"])
        self.assert_error("forbidden", 403, self.service.create_invite, employee)
        self.assert_error("forbidden", 403, self.service.create_invite,
                          replace(employee, role="admin"))
        self.assert_error("forbidden", 403, self.service.list_invites, employee)
        self.assert_error("forbidden", 403, self.service.issue_reset, employee, ADMIN_UID)

    def test_admin_not_assignable_by_client(self):
        invite = self.service.create_invite(self.owner)
        with self.assertRaises(TypeError):
            self.service.register("employee@example.test", PASSWORD, invite["code"], role="admin")
        auth = self.service.register("employee@example.test", PASSWORD, invite["code"])
        self.assertEqual(auth["user"]["role"], "employee")
        self.assertEqual(self.service.authenticate(auth["accessToken"]).role, "employee")

    def test_reset_revokes_sessions(self):
        auth = self.register_employee()
        another = self.service.login("employee@example.test", PASSWORD, "192.0.2.1")
        uid = auth["user"]["uid"]
        pending = self.service.issue_reset(self.owner, uid)
        reset = self.service.issue_reset(self.owner, uid)
        self.service.redeem_reset(reset["code"], NEW_PASSWORD)
        for session in (auth, another):
            with self.subTest(access=session is auth):
                self.assert_error("invalid_session", 401, self.service.authenticate, session["accessToken"])
                self.assert_error("invalid_session", 401, self.service.renew, session["refreshToken"])
        for code in (reset["code"], pending["code"]):
            self.assert_error("invalid_reset", 422, self.service.redeem_reset, code, PASSWORD)
        self.assert_error("invalid_credentials", 401, self.service.login,
                          "employee@example.test", PASSWORD, "192.0.2.1")
        self.assertEqual(self.service.login("employee@example.test", NEW_PASSWORD,
                                            "192.0.2.1")["user"]["uid"], uid)

    def test_expired_reset_cannot_change_password(self):
        auth = self.register_employee()
        reset = self.service.issue_reset(self.owner, auth["user"]["uid"])
        self.now += 60 * 60
        self.assert_error("invalid_reset", 422, self.service.redeem_reset, reset["code"], NEW_PASSWORD)
        self.service.login("employee@example.test", PASSWORD, "192.0.2.1")

    def test_renewal_rotation(self):
        auth = self.register_employee()
        self.now += 15 * 60
        self.assert_error("invalid_session", 401, self.service.authenticate, auth["accessToken"])
        renewed = self.service.renew(auth["refreshToken"])
        self.assertEqual(renewed["user"], auth["user"])
        self.assert_error("invalid_session", 401, self.service.renew, auth["refreshToken"])
        self.service.authenticate(renewed["accessToken"])
        self.now += 7 * 24 * 60 * 60 - 15 * 60
        self.assert_error("invalid_session", 401, self.service.renew, renewed["refreshToken"])

    def test_logout_invalidates_rotated_session(self):
        auth = self.register_employee()
        renewed = self.service.renew(auth["refreshToken"])
        self.assert_error("invalid_session", 401, self.service.authenticate, auth["accessToken"])
        # A sign-out racing with renewal can still invalidate the session family.
        self.service.logout(auth["accessToken"])
        self.service.logout(auth["accessToken"])
        self.assert_error("invalid_session", 401, self.service.authenticate, renewed["accessToken"])
        self.assert_error("invalid_session", 401, self.service.renew, renewed["refreshToken"])

    def test_rate_limit(self):
        employee = self.register_employee()
        for index in range(10):
            self.assert_error("invalid_credentials", 401, self.service.login,
                              " EMPLOYEE@example.test ", "bad credential", f"192.0.2.{index + 1}")
        self.assert_error("rate_limited", 429, self.service.login,
                          "employee@example.test", PASSWORD, "192.0.2.100")
        self.now += 15 * 60
        self.assertEqual(self.service.login("employee@example.test", PASSWORD,
                                            "192.0.2.100")["user"], employee["user"])

    def test_rate_limit_by_ip_across_email_addresses(self):
        self.assert_error("invalid_credentials", 401, self.service.login,
                          "first@example.test", "short", "192.0.2.1")
        self.now += 1
        for index in range(99):
            self.assert_error("invalid_credentials", 401, self.service.login,
                              f"missing{index}@example.test", "short", "192.0.2.1")
        self.now += 15 * 60 - 2
        self.assert_error("rate_limited", 429, self.service.login,
                          "another@example.test", "short", "192.0.2.1")
        self.now += 1
        self.assert_error("invalid_credentials", 401, self.service.login,
                          "another@example.test", "short", "192.0.2.1")
        self.assert_error("rate_limited", 429, self.service.login,
                          "last@example.test", "short", "192.0.2.1")

    def test_no_secret_in_records(self):
        invite = self.service.create_invite(self.owner)
        auth = self.service.register("employee@example.test", PASSWORD, invite["code"])
        reset = self.service.issue_reset(self.owner, auth["user"]["uid"])
        account = self.store.run_read(lambda tx: tx.get_account(auth["user"]["uid"]))
        self.assertTrue(account.password_hash.startswith("$argon2id$"))
        stored = repr(self.store.records)
        for secret in (PASSWORD, invite["code"], auth["accessToken"], auth["refreshToken"], reset["code"]):
            self.assertNotIn(secret, stored)
        listing = self.service.list_invites(self.owner)
        self.assertNotIn(invite["code"], repr(listing))
        self.assertNotIn("code", listing["invites"][0])

    def test_password_validation_preserves_spaces(self):
        invite = self.service.create_invite(self.owner)
        for invalid in ("a" * 11, "a" * 129):
            self.assert_error("invalid_password", 422, self.service.register,
                              "employee@example.test", invalid, invite["code"])
        password = " space bounded "
        self.service.register("employee@example.test", password, invite["code"])
        self.assert_error("invalid_credentials", 401, self.service.login,
                          "employee@example.test", password.strip(), "192.0.2.1")
        self.service.login("employee@example.test", password, "192.0.2.1")

    def test_owner_bootstrap_requires_out_of_band_promotion(self):
        store = FakeStore()
        service = Service(store, clock=lambda: self.now)
        seed = partial(seed_owner_invite, store, clock=lambda: self.now)
        invite = seed()
        auth = service.register("new-owner@example.test", PASSWORD, invite["code"])
        principal = service.authenticate(auth["accessToken"])
        self.assertEqual(principal.role, "employee")
        self.assert_error("bootstrap_unavailable", 409, seed)
        self.assert_error("bootstrap_unavailable", 409, promote_owner, store, ADMIN_UID, invite["id"])
        promote_owner(store, principal.uid, invite["id"], clock=lambda: self.now)
        self.assert_error("invalid_session", 401, service.authenticate, auth["accessToken"])
        new_auth = service.login("new-owner@example.test", PASSWORD, "192.0.2.1")
        self.assertEqual(new_auth["user"]["role"], "admin")
        self.assert_error("bootstrap_unavailable", 409, seed)
        self.assert_error("bootstrap_unavailable", 409, promote_owner, store, principal.uid, invite["id"])

    def test_expired_bootstrap_invite_can_be_replaced(self):
        store = FakeStore()
        service = Service(store, clock=lambda: self.now)
        seed = partial(seed_owner_invite, store, clock=lambda: self.now)
        expired = seed()
        self.now += 7 * 24 * 60 * 60
        replacement = seed()
        self.assert_error("invalid_invite", 422, service.register,
                          "new-owner@example.test", PASSWORD, expired["code"])
        auth = service.register("new-owner@example.test", PASSWORD, replacement["code"])
        uid = auth["user"]["uid"]
        self.assert_error("bootstrap_unavailable", 409, promote_owner, store, uid, expired["id"])
        promote_owner(store, uid, replacement["id"], clock=lambda: self.now)
        self.assertEqual(service.login("new-owner@example.test", PASSWORD, "192.0.2.1")["user"]["role"], "admin")

    def test_lost_unredeemed_bootstrap_is_revoked_by_reissue(self):
        store = FakeStore()
        service = Service(store, clock=lambda: self.now)
        seed = partial(seed_owner_invite, store, clock=lambda: self.now)
        lost, replacement = seed(), seed()
        self.assert_error("invalid_invite", 422, service.register,
                          "new-owner@example.test", PASSWORD, lost["code"])
        auth = service.register("new-owner@example.test", PASSWORD, replacement["code"])
        promote_owner(store, auth["user"]["uid"], replacement["id"], clock=lambda: self.now)
        admin = service.login("new-owner@example.test", PASSWORD, "192.0.2.1")
        listing = service.list_invites(service.authenticate(admin["accessToken"]))
        states = {item["id"]: item["state"] for item in listing["invites"]}
        self.assertEqual(states, {lost["id"]: "revoked", replacement["id"]: "used"})
        audit = {(event.action, event.target_id) for event in store.records["audit_events"].values()}
        self.assertIn(("bootstrap_invite_created", lost["id"]), audit)
        self.assertIn(("bootstrap_invite_revoked", lost["id"]), audit)
        self.assertIn(("bootstrap_invite_created", replacement["id"]), audit)

    def test_bootstrap_reissue_after_registration_precheck_revokes_old_invite(self):
        store = FakeStore()
        seed = partial(seed_owner_invite, store, clock=lambda: self.now)
        initial = seed()
        prechecked = Event()
        resume = Event()

        def delayed_token():
            prechecked.set()
            self.assertTrue(resume.wait(timeout=5))
            return new_token()

        service = Service(store, clock=lambda: self.now, tokens=delayed_token)
        with ThreadPoolExecutor(max_workers=1) as executor:
            registration = executor.submit(
                service.register, "unexpected@example.test", PASSWORD, initial["code"]
            )
            try:
                self.assertTrue(prechecked.wait(timeout=5))
                replacement = seed()
            finally:
                resume.set()
            self.assert_error("invalid_invite", 422, registration.result)

        auth = service.register("new-owner@example.test", PASSWORD, replacement["code"])
        promote_owner(store, auth["user"]["uid"], replacement["id"], clock=lambda: self.now)
