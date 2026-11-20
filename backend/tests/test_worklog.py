import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date, timedelta
from threading import Barrier
from uuid import UUID

from backend.service import DomainError, Principal, Service
from backend.store import Account
from fake_store import FakeStore, seed_test_session


NOW = 1_700_000_000


def snapshot(hours="8.5"):
    return {
        "version": 1,
        "settings": {
            "th1": 3, "th2": "13", "coef": 1.5, "anchor": "2026-11-13",
            "p1": 3, "p2": 3, "p3": 3, "rates": {"1": 280, "2": 322, "3": "350"},
        },
        "days": {
            "2026-11-20": {
                "date": "2026-11-20",
                "main": {"hours": hours, "route": 1, "departure": "", "after": False},
                "pod": {"s1": {"hours": "2", "route": "2", "departure": "14:30"}},
            },
        },
    }


def insert_account(store, index, role="employee"):
    uid = str(UUID(int=index, version=4))
    account = Account(uid, f"person-{index}@example.test", "test-only", role, True, NOW, 0)
    store.run_write(lambda tx: tx.insert_account(account))
    return account


class WorklogTest(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.service = Service(self.store, clock=lambda: NOW)
        admin = insert_account(self.store, 1, "admin")
        staff = insert_account(self.store, 2)
        self.admin = self.service.authenticate(seed_test_session(self.store, admin, NOW))
        self.staff = self.service.authenticate(seed_test_session(self.store, staff, NOW))

    def assert_error(self, code, status, action, *args):
        with self.assertRaises(DomainError) as result:
            action(*args)
        self.assertEqual((result.exception.code, result.exception.status), (code, status))

    def test_staff_cannot_list_or_read_other(self):
        self.assert_error("forbidden", 403, self.service.list_employees, self.staff)
        self.assert_error("forbidden", 403, self.service.get_employee, self.staff, self.admin.uid)
        forged = replace(self.staff, role="admin")
        self.assert_error("forbidden", 403, self.service.list_employees, forged)

    def test_admin_read_only_others_own_write_ok(self):
        self.assertEqual(self.service.get_worklog(self.staff), {"data": None, "revision": 0})
        self.service.put_worklog(self.staff, snapshot("4"), 0, "first-save")
        self.assertEqual(self.service.get_employee(self.admin, self.staff.uid), {
            "profile": {"email": self.staff.email}, "worklog": snapshot("4"),
        })
        self.service.put_worklog(self.admin, snapshot(), 0, "first-save")
        self.assertEqual(self.service.get_worklog(self.admin), {"data": snapshot(), "revision": 1})
        self.assertEqual(self.service.get_worklog(self.staff), {"data": snapshot("4"), "revision": 1})
        self.assertEqual(self.service.list_employees(self.admin)["users"][self.staff.uid], {
            "profile": {"email": self.staff.email}, "worklog": snapshot("4"),
        })

    def test_disabled_account_cannot_access_own_snapshot(self):
        account = self.store.records["accounts"][self.staff.uid]
        self.store.records["accounts"][self.staff.uid] = replace(account, enabled=False)
        self.assert_error("invalid_session", 401, self.service.get_worklog, self.staff)
        self.assert_error("invalid_session", 401, self.service.put_worklog, self.staff, snapshot(), 0, "save")

    def test_identity_only_principal_cannot_read_or_write(self):
        claimed = Principal(self.staff.uid, self.staff.email, self.staff.role)
        self.assert_error("invalid_session", 401, self.service.get_worklog, claimed)
        self.assert_error("invalid_session", 401, self.service.put_worklog, claimed, snapshot(), 0, "save")
        self.assertFalse(self.store.records["worklogs"])

    def test_legacy_settings_outside_previous_limits_are_preserved(self):
        data = snapshot("25")
        data["settings"].update(th2="25", p3=367, coef="101")
        data["settings"]["rates"]["2"] = "1000001"
        self.assertEqual(self.service.put_worklog(self.staff, data, 0, "legacy-settings")["revision"], 1)
        self.assertEqual(self.service.get_worklog(self.staff), {"data": data, "revision": 1})

    def test_invalid_settings_outside_finite_upper_bounds_are_rejected(self):
        for field, value in (
            ("th2", "1000001"), ("p3", 1_000_001), ("coef", "Infinity"),
            ("rates", {"1": "1000000001", "2": 0, "3": 0}),
        ):
            with self.subTest(field=field, value=value):
                data = snapshot()
                data["settings"][field] = value
                self.assert_error("invalid_worklog", 422, self.service.put_worklog, self.staff, data, 0, "save")

    def test_employee_list_has_bounded_cursor_pages(self):
        for index in range(3, 8):
            insert_account(self.store, index)
        cursor, seen = "", {}
        for _ in range(3):
            page = self.service.list_employees(self.admin, cursor)
            users = page["users"]
            self.assertLessEqual(len(users), 3)
            self.assertFalse(seen.keys() & users.keys())
            seen.update(users)
            cursor = page.get("nextCursor")
            if cursor is None:
                break
        self.assertIsNone(cursor)
        for index in range(2, 8):
            self.assertIn({"profile": {"email": f"person-{index}@example.test"}, "worklog": None}, seen.values())

    def test_stale_revision_rejected(self):
        self.service.put_worklog(self.staff, snapshot(), 0, "first")
        self.assert_error("stale_revision", 409, self.service.put_worklog, self.staff, snapshot("4"), 0, "second")
        self.assertEqual(self.service.get_worklog(self.staff), {"data": snapshot(), "revision": 1})

    def test_lost_response_retry_idempotent(self):
        first = self.service.put_worklog(self.staff, snapshot(), 0, "first")
        self.assertEqual(first, {"revision": 1, "updatedAt": "2023-11-14T22:13:20Z"})
        self.service.put_worklog(self.staff, snapshot("4"), 1, "second")
        repeated = snapshot()
        repeated["settings"] = dict(reversed(list(repeated["settings"].items())))
        self.assertEqual(self.service.put_worklog(self.staff, repeated, 0, "first"), first)
        self.assertEqual(self.service.get_worklog(self.staff), {"data": snapshot("4"), "revision": 2})
        edits = {(audit.action, audit.actor_uid, audit.target_id) for audit in self.store.records["audit_events"].values()}
        self.assertEqual(edits, {("worklog_updated", self.staff.uid, self.staff.uid)})
        self.assertEqual(len(self.store.records["audit_events"]), 2)

    def test_same_mutation_id_different_body_rejected(self):
        self.service.put_worklog(self.staff, snapshot(), 0, "first")
        for changed, revision in ((snapshot("4"), 0), (snapshot(), 1)):
            self.assert_error("mutation_mismatch", 409, self.service.put_worklog, self.staff, changed, revision, "first")
        self.assertEqual(self.service.get_worklog(self.staff), {"data": snapshot(), "revision": 1})

    def test_two_devices_only_one_write_wins(self):
        start = Barrier(2)

        def attempt(index):
            start.wait(timeout=5)
            try:
                return self.service.put_worklog(self.staff, snapshot(str(index)), 0, f"device-{index}")
            except DomainError as error:
                self.assertEqual((error.code, error.status), ("stale_revision", 409))
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(attempt, (1, 2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        winner = 1 if results[0] is not None else 2
        self.assertEqual(self.service.get_worklog(self.staff), {"data": snapshot(str(winner)), "revision": 1})

    def test_invalid_oversize_and_nonfinite_payload(self):
        for hours in (float("nan"), float("inf"), "Infinity", "1e10000", True, -1, 169, "9" * 524_288):
            with self.subTest(hours=repr(hours)[:24]):
                self.assert_error("invalid_worklog", 422, self.service.put_worklog, self.staff, snapshot(hours), 0, "first")
        self.assertFalse(self.store.records["worklogs"])

    def test_valid_snapshot_over_size_limit_is_rejected(self):
        data = snapshot()
        data["days"] = {}
        for offset in range(8_000):
            key = (date(2010, 1, 1) + timedelta(days=offset)).isoformat()
            data["days"][key] = {"date": key, "main": {"hours": "8.5", "route": 2}}
        self.assert_error("invalid_worklog", 422, self.service.put_worklog, self.staff, data, 0, "first")
        self.assertEqual(self.service.get_worklog(self.staff), {"data": None, "revision": 0})

    def test_invalid_snapshot_fields(self):
        replacements = [
            ("version", True),
            ("ownerUid", self.admin.uid),
            ("settings", {}),
            ("days", {"2026-02-29": {"date": "2026-02-29"}}),
            ("days", {"2026-11-20": {"date": "2026-11-21"}}),
            ("days", {"2026-11-20": {"date": "2026-11-20", "main": {"hours": 1, "route": 4}}}),
            ("days", {"2026-11-20": {"date": "2026-11-20", "main": {"hours": 1, "route": 1, "after": "false"}}}),
            ("days", {"2026-11-20": {"date": "2026-11-20", "main": {"hours": 1, "route": 1, "departure": "24:00"}}}),
        ]
        for field, value in replacements:
            with self.subTest(field=field, value=value):
                self.assert_error("invalid_worklog", 422, self.service.put_worklog,
                                  self.staff, {**snapshot(), field: value}, 0, "first")
