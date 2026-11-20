import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import index


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.context = SimpleNamespace(token={"access_token": "mock-token"})
        self.objects = {}
        self.fake = patch.object(index, "storage", side_effect=self.storage)
        self.fake.start()
        self.addCleanup(self.fake.stop)
        self.env = patch.dict(os.environ, {"WORKLOG_BACKUPS_ENABLED": "0"})
        self.env.start()
        self.addCleanup(self.env.stop)

    def storage(self, method, key, token, data=None):
        self.assertEqual(token, "mock-token")
        if method == "PUT":
            self.objects[key] = data
            return b""
        return self.objects[key]

    def test_probe(self):
        result = index.handler({"action": "probe"}, self.context)
        self.assertEqual(result["statusCode"], 200)
        self.assertIn("_diagnostics/probe.json", self.objects)
        self.assertNotIn("mock-token", result["body"])

    def test_missing_token(self):
        self.assertEqual(index.handler({"action": "probe"}, SimpleNamespace())["statusCode"], 503)

    def test_backup_disabled(self):
        self.assertEqual(index.handler({"action": "save"}, self.context)["statusCode"], 403)
        self.assertEqual(self.objects, {})

    def test_round_trip(self):
        os.environ["WORKLOG_BACKUPS_ENABLED"] = "1"
        backup = {"settings": {"currency": "RUB"}, "days": {}, "version": 1}
        result = index.handler({"action": "save", "backup": backup}, self.context)
        self.assertEqual(result["statusCode"], 201)
        backup_id = json.loads(result["body"])["backupId"]
        result = index.handler({"action": "load", "backupId": backup_id}, self.context)
        self.assertEqual(json.loads(result["body"])["backup"], backup)

    def test_invalid_path(self):
        os.environ["WORKLOG_BACKUPS_ENABLED"] = "1"
        result = index.handler({"action": "load", "backupId": "../secret"}, self.context)
        self.assertEqual(result["statusCode"], 400)

    def test_http_body(self):
        result = index.handler({"httpMethod": "POST", "body": '{"action":"probe"}'}, self.context)
        self.assertEqual(result["statusCode"], 200)

if __name__ == "__main__":
    unittest.main()
