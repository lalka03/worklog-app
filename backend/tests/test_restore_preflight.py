"""Offline-only tests for the Cloud Shell preflight (no yc calls actually made)."""
import contextlib
import io
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
MODULE = runpy.run_path(str(ROOT / "scripts/operator-restore-readonly-preflight.py"))
check = MODULE["check"]
main = MODULE["main"]

FOLDER = "b1gbctisrf70nalca0ve"
SOURCE = {
    "id": "etntoapt41gu9i5u5blj", "name": "worklog-yandex-test-db",
    "folder_id": FOLDER, "status": "RUNNING",
}
INVENTORY = [dict(SOURCE)]


class RestorePreflightTest(unittest.TestCase):
    def test_healthy_metadata_does_not_claim_billing_verified(self):
        self.assertEqual(
            check(FOLDER, SOURCE, INVENTORY), "METADATA_READY_BILLING_NOT_VERIFIED"
        )

    def test_any_unexpected_folder_or_source_stops(self):
        self.assertEqual(check("some-other-folder", SOURCE, INVENTORY), "WRONG_FOLDER_STOP")
        self.assertEqual(check(FOLDER, {**SOURCE, "id": "unexpected"}, INVENTORY),
                         "WRONG_SOURCE_DATABASE_STOP")
        self.assertEqual(check(FOLDER, {**SOURCE, "folder_id": "unexpected"}, INVENTORY),
                         "WRONG_SOURCE_FOLDER_STOP")
        self.assertEqual(check(FOLDER, {**SOURCE, "status": "CREATING"}, INVENTORY),
                         "SOURCE_NOT_RUNNING_STOP")

    def test_existing_target_or_incomplete_database_list_stops(self):
        target = {"id": "test-id", "name": "worklog-restore-qa-20261123"}
        self.assertEqual(check(FOLDER, SOURCE, INVENTORY + [target]),
                         "RESTORE_DB_ALREADY_EXISTS_STOP")
        self.assertEqual(check(FOLDER, SOURCE, []), "SOURCE_NOT_LISTED_STOP")
        self.assertEqual(check(FOLDER, SOURCE, {"unexpected": True}),
                         "INVALID_DATABASE_LIST_STOP")

    def test_main_only_invokes_read_commands_and_prints_no_cloud_data(self):
        observed = []
        def fake_output(command, **kwargs):
            observed.append(command)
            if command[1:3] == ["config", "get"]:
                return FOLDER + "\n"
            if command[1:4] == ["ydb", "database", "get"]:
                import json
                return json.dumps(SOURCE)
            if command[1:4] == ["ydb", "database", "list"]:
                import json
                return json.dumps(INVENTORY)
            raise AssertionError("unexpected command")
        output = io.StringIO()
        with patch.object(MODULE["subprocess"], "check_output", side_effect=fake_output), contextlib.redirect_stdout(output):
            self.assertEqual(main(), 0)
        self.assertEqual(len(observed), 3)
        self.assertIn("METADATA_READY_BILLING_NOT_VERIFIED", output.getvalue())
        self.assertIn("NO_DB_CREATED", output.getvalue())
        self.assertNotIn(SOURCE["id"], output.getvalue())
        self.assertNotIn(FOLDER, output.getvalue())


if __name__ == "__main__":
    unittest.main()
