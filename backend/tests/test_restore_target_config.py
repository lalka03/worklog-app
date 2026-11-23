"""Pure in-memory security tests for future disposable YDB restore target checks."""
import contextlib
import io
import json
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
MODULE = runpy.run_path(str(ROOT / "scripts/operator-restore-target-config-check.py"))
check = MODULE["check_target"]
main = MODULE["main"]

FOLDER = "b1gbctisrf70nalca0ve"
TARGET = "etn12345678901234567"
SOURCE = "etntoapt41gu9i5u5blj"
EXACT_PATH = "/ru-central1/" + FOLDER + "/" + TARGET


def healthy():
    return {
        "id": TARGET,
        "name": "worklog-restore-qa-20261123",
        "folder_id": FOLDER,
        "status": "RUNNING",
        "serverless_database": {
            "storage_size_limit": "1073741824",
            "enable_throttling_rcu_limit": True,
            "throttling_rcu_limit": "10",
            "provisioned_rcu_limit": "0",
        },
        "endpoint": "grpcs://ydb.serverless.yandexcloud.net:2135/?database=" + EXACT_PATH,
    }


class TargetConfigTest(unittest.TestCase):
    def test_correct_bounds_are_readonly_and_not_billing_approval(self):
        self.assertEqual(check(TARGET, healthy()), "TARGET_LIMITS_VERIFIED_BILLING_NOT_VERIFIED")

    def test_wrong_identity_and_database_mode_fail_closed(self):
        for broken, expected in [
            ({"id": "etn00000000000000000"}, "WRONG_TARGET_STOP"),
            ({"name": "worklog-yandex-test-db"}, "WRONG_TARGET_STOP"),
            ({"folder_id": "some-other-folder"}, "WRONG_TARGET_STOP"),
            ({"status": "PROVISIONING"}, "TARGET_NOT_RUNNING_STOP"),
            ({"dedicated_database": {}}, "DEDICATED_DATABASE_STOP"),
            ({"serverless_database": None}, "NOT_SERVERLESS_STOP"),
        ]:
            with self.subTest(broken=broken):
                self.assertEqual(check(TARGET, {**healthy(), **broken}), expected)
        self.assertEqual(check(SOURCE, healthy()), "SOURCE_ID_AS_TARGET_STOP")

    def test_missing_or_oversized_storage_cannot_pass(self):
        for value in [None, 0, "0", "1073741825", "not-a-number", True]:
            with self.subTest(storage=value):
                data = healthy()
                data["serverless_database"]["storage_size_limit"] = value
                self.assertEqual(check(TARGET, data), "STORAGE_LIMIT_STOP")

    def test_throttling_must_be_enabled_and_bounded(self):
        data = healthy()
        data["serverless_database"]["enable_throttling_rcu_limit"] = False
        self.assertEqual(check(TARGET, data), "THROTTLING_DISABLED_STOP")
        for value in [None, 0, "0", "11", "bad", True]:
            with self.subTest(rcu=value):
                data = healthy()
                data["serverless_database"]["throttling_rcu_limit"] = value
                self.assertEqual(check(TARGET, data), "RU_LIMIT_STOP")

    def test_paid_reservation_cannot_be_enabled(self):
        for value in [None, 1, "10", "-1", True]:
            with self.subTest(reserved=value):
                data = healthy()
                data["serverless_database"]["provisioned_rcu_limit"] = value
                self.assertEqual(check(TARGET, data), "RESERVED_PAID_CAPACITY_STOP")

    def test_wrong_endpoint_never_accepted(self):
        for endpoint in [
            "grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/" + FOLDER + "/" + SOURCE,
            "grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/other/" + TARGET,
            "grpc://ydb.serverless.yandexcloud.net:2135/?database=" + EXACT_PATH,
            "grpcs://attacker.example:2135/?database=" + EXACT_PATH,
            "grpcs://ydb.serverless.yandexcloud.net:2135/?database=" + EXACT_PATH + "&database=duplicate",
            "grpcs://ydb.serverless.yandexcloud.net:1234/?database=" + EXACT_PATH,
            "",
        ]:
            with self.subTest(endpoint=endpoint):
                self.assertEqual(check(TARGET, {**healthy(), "endpoint": endpoint}),
                                 "TARGET_ENDPOINT_STOP")

    def test_main_issues_only_two_read_operations_with_no_secrets_in_output(self):
        calls = []
        def fake_command(argv, **kwargs):
            calls.append(argv)
            if argv[1:3] == ["config", "get"]:
                return FOLDER + "\n"
            if argv[1:4] == ["ydb", "database", "get"]:
                return json.dumps(healthy())
            raise AssertionError("unexpected command")
        result = io.StringIO()
        with patch.object(MODULE["subprocess"], "check_output", side_effect=fake_command), contextlib.redirect_stdout(result):
            self.assertEqual(main(["--target-id", TARGET]), 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1], ["yc", "ydb", "database", "get", "--id", TARGET, "--format", "json"])
        self.assertIn("TARGET_LIMITS_VERIFIED_BILLING_NOT_VERIFIED", result.getvalue())
        self.assertIn("NO_RESTORE_PERFORMED", result.getvalue())
        self.assertNotIn(TARGET, result.getvalue())
        self.assertNotIn(FOLDER, result.getvalue())

    def test_main_never_queries_source_database_as_target(self):
        with patch.object(MODULE["subprocess"], "check_output") as query, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--target-id", SOURCE]), 1)
            query.assert_not_called()


if __name__ == "__main__":
    unittest.main()
