import base64
import json
import unittest
from unittest.mock import patch

from backend.index import handle
from backend.security import digest
from backend.service import DomainError, Service
from backend.store import Session, StoreUnavailable
from fake_store import FakeStore, FakeTransaction, seed_test_session
from test_worklog import NOW, insert_account, snapshot


ADMIN_TOKEN = "admin-token-synthetic-test-0123456789"
STAFF_TOKEN = "staff-token-synthetic-test-0123456789"
PASSWORD = "synthetic test password"


def event(method, path, body=None, *, token=None, origin=None, headers=None, ip="192.0.2.10", query=None):
    values = {"content-type": "application/json", **(headers or {})}
    if token is not None:
        values["authorization"] = f"Bearer {token}"
    if origin is not None:
        values["origin"] = origin
    return {
        "version": "2.0", "rawPath": path, "headers": values,
        "requestContext": {"http": {"method": method, "path": path, "sourceIp": ip}},
        "queryStringParameters": query, "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
    }


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.service = Service(self.store, clock=lambda: NOW)
        admin = insert_account(self.store, 1, "admin")
        staff = insert_account(self.store, 2)
        self.admin = self.service.authenticate(seed_test_session(self.store, admin, NOW, ADMIN_TOKEN))
        self.staff = self.service.authenticate(seed_test_session(self.store, staff, NOW, STAFF_TOKEN))

    def assert_reply(self, response, status, payload=None):
        self.assertEqual(response["statusCode"], status, response)
        self.assertEqual(response["headers"]["Cache-Control"], "no-store")
        if payload is not None:
            self.assertEqual(json.loads(response["body"]), payload)
        return json.loads(response["body"]) if response["body"] else None

    def request(self, *args, **kwargs):
        return handle(event(*args, **kwargs), self.service)

    def test_only_login_accepts_optional_boolean_remember(self):
        invite = self.service.create_invite(self.admin)
        credentials = {"email": "remember@example.test", "password": PASSWORD}
        self.assert_reply(self.request("POST", "/auth/register", {**credentials, "invite": invite["code"], "remember": True}), 422)
        self.assert_reply(self.request("POST", "/auth/register", {**credentials, "invite": invite["code"]}), 200)
        for invalid in (None, 1, 0, "true", [], {}):
            self.assert_reply(self.request("POST", "/auth/login", {**credentials, "remember": invalid}), 422, {"error": "invalid_request"})
        self.assert_reply(self.request("POST", "/auth/login", {**credentials, "remember": True, "role": "admin"}), 422)
        auth = self.assert_reply(self.request("POST", "/auth/login", {**credentials, "remember": True}), 200)
        self.assertEqual(auth["user"]["role"], "employee")
        self.assert_reply(self.request("POST", "/auth/renew", {"refreshToken": auth["refreshToken"], "remember": True}), 422)

    def test_staff_cannot_list_or_read_other(self):
        for method, path in (
            ("GET", "/admin/employees"), ("GET", f"/admin/employees/{self.admin.uid}"),
            ("GET", "/admin/invites"), ("POST", "/admin/invites"),
            ("DELETE", f"/admin/invites/{self.staff.uid}"),
            ("POST", f"/admin/users/{self.admin.uid}/reset"),
        ):
            with self.subTest(method=method, path=path):
                self.assert_reply(self.request(method, path, token=STAFF_TOKEN), 403, {"error": "forbidden"})

    def test_admin_read_only_others_own_write_ok(self):
        body = {"data": snapshot(), "expectedRevision": 0, "mutationId": "device-1"}
        self.assert_reply(self.request("PUT", f"/admin/employees/{self.staff.uid}", body, token=ADMIN_TOKEN),
                          405, {"error": "method_not_allowed"})
        self.assert_reply(self.request("PUT", f"/me/worklog/{self.staff.uid}", body, token=ADMIN_TOKEN),
                          404, {"error": "not_found"})
        self.assert_reply(self.request("PUT", "/me/worklog", body, token=ADMIN_TOKEN), 200,
                          {"revision": 1, "updatedAt": "2023-11-14T22:13:20Z"})
        self.assert_reply(self.request("GET", "/me/worklog", token=ADMIN_TOKEN), 200,
                          {"data": snapshot(), "revision": 1})
        self.assert_reply(self.request("GET", f"/admin/employees/{self.staff.uid}", token=ADMIN_TOKEN), 200,
                          {"profile": {"email": self.staff.email}, "worklog": None})

    def test_unknown_fields_cannot_escalate(self):
        invite = self.service.create_invite(self.admin)
        registration = {"email": "new-person@example.test", "password": PASSWORD, "invite": invite["code"]}
        for key in ("uid", "role"):
            self.assert_reply(self.request("POST", "/auth/register", {**registration, key: "admin"}),
                              422, {"error": "invalid_request"})
            write = {"data": snapshot(), "expectedRevision": 0, "mutationId": "m1", key: self.staff.uid}
            self.assert_reply(self.request("PUT", "/me/worklog", write, token=ADMIN_TOKEN),
                              422, {"error": "invalid_request"})
        registered = self.assert_reply(self.request("POST", "/auth/register", registration), 200)
        self.assertEqual(registered["user"]["role"], "employee")
        self.assertNotEqual(registered["user"]["uid"], self.admin.uid)

    def test_invite_list_never_discloses_code(self):
        created = self.assert_reply(self.request("POST", "/admin/invites", {}, token=ADMIN_TOKEN), 200)
        response = self.request("GET", "/admin/invites", token=ADMIN_TOKEN)
        invite = self.assert_reply(response, 200)["invites"][0]
        self.assertEqual(invite["id"], created["id"])
        self.assertNotIn("code", invite)
        self.assertNotIn("digest", invite)
        self.assertNotIn(created["code"], response["body"])

    def test_invalid_token_denies_before_data_query(self):
        with patch.object(FakeTransaction, "get_worklog", side_effect=AssertionError("queried worklog")), \
             patch.object(FakeTransaction, "list_accounts", side_effect=AssertionError("queried employees")):
            for path in ("/me/worklog", "/admin/employees", f"/admin/employees/{self.staff.uid}"):
                self.assert_reply(self.request("GET", path, token="invalid-synthetic-token-0123456789"), 401,
                                  {"error": "invalid_session"})

    def test_password_reset_between_authentication_and_worklog_write_denies_write(self):
        reset = self.service.issue_reset(self.admin, self.staff.uid)
        authenticate = self.service.authenticate

        def authenticate_then_reset(token):
            principal = authenticate(token)
            self.service.redeem_reset(reset["code"], PASSWORD)
            return principal

        body = {"data": snapshot(), "expectedRevision": 0, "mutationId": "pending-write"}
        with patch.object(self.service, "authenticate", side_effect=authenticate_then_reset):
            self.assert_reply(self.request("PUT", "/me/worklog", body, token=STAFF_TOKEN), 401,
                              {"error": "invalid_session"})
        self.assertFalse(self.store.records["worklogs"])
        self.assertFalse(self.store.records["mutations"])

    def test_logout_between_authentication_and_worklog_read_denies_read(self):
        self.service.put_worklog(self.staff, snapshot(), 0, "first-write")
        authenticate = self.service.authenticate

        def authenticate_then_logout(token):
            principal = authenticate(token)
            self.assert_reply(self.request("POST", "/auth/logout", token=token), 200, {})
            return principal

        with patch.object(self.service, "authenticate", side_effect=authenticate_then_logout):
            self.assert_reply(self.request("GET", "/me/worklog", token=STAFF_TOKEN), 401,
                              {"error": "invalid_session"})

    def test_logged_out_admin_principal_cannot_access_protected_operations(self):
        admin = self.service.authenticate(ADMIN_TOKEN)
        invite_id = self.service.create_invite(admin)["id"]
        self.service.logout(ADMIN_TOKEN)
        operations = (
            (self.service.list_employees,),
            (self.service.get_employee, self.staff.uid),
            (self.service.list_invites,),
            (self.service.create_invite,),
            (self.service.revoke_invite, invite_id),
            (self.service.issue_reset, self.staff.uid),
        )
        for operation, *args in operations:
            with self.subTest(operation=operation.__name__):
                with self.assertRaises(DomainError) as error:
                    operation(admin, *args)
                self.assertEqual((error.exception.code, error.exception.status), ("invalid_session", 401))
        self.assertEqual(len(self.store.records["invitations"]), 1)
        self.assertFalse(self.store.records["reset_tokens"])

    def test_wrong_origin_and_method(self):
        self.assert_reply(self.request("GET", "/me/worklog", token=STAFF_TOKEN, origin="https://other.test"),
                          403, {"error": "origin_forbidden"})
        self.assert_reply(self.request("POST", "/me/worklog", token=STAFF_TOKEN, origin="https://localhost"),
                          405, {"error": "method_not_allowed"})
        response = self.request("OPTIONS", "/me/worklog", origin="https://localhost", headers={
            "access-control-request-method": "PUT", "access-control-request-headers": "authorization, content-type",
        })
        self.assert_reply(response, 204)
        self.assertEqual(response["headers"]["Access-Control-Allow-Origin"], "https://localhost")
        self.assertIn("PUT", response["headers"]["Access-Control-Allow-Methods"])
        self.assertEqual(response["body"], "")
        response = self.request("GET", "/me/worklog", token=STAFF_TOKEN, origin="http://localhost")
        self.assert_reply(response, 200)
        self.assertEqual(response["headers"]["Access-Control-Allow-Origin"], "http://localhost")

    def test_invalid_oversize_and_nonfinite_payload(self):
        for hours in (float("nan"), "9" * 524_288):
            body = {"data": snapshot(hours), "expectedRevision": 0, "mutationId": "device-1"}
            self.assert_reply(self.request("PUT", "/me/worklog", body, token=STAFF_TOKEN), 422)
        for raw in ('{"data":1e999}', '{"uid":"a","uid":"b"}', "{" * 1_100):
            request = event("PUT", "/me/worklog", token=STAFF_TOKEN)
            request["body"] = raw
            self.assert_reply(handle(request, self.service), 422, {"error": "invalid_request"})

    def test_base64_gateway_body(self):
        request = event("PUT", "/me/worklog",
                        {"data": snapshot(), "expectedRevision": 0, "mutationId": "m1"}, token=STAFF_TOKEN)
        request["body"] = base64.b64encode(request["body"].encode()).decode()
        request["isBase64Encoded"] = True
        self.assert_reply(handle(request, self.service), 200)

    def test_worklog_bearer_header_survives_gateway_filtering(self):
        response = self.request("GET", "/me/worklog", headers={
            "X-Worklog-Authorization": f"Bearer {STAFF_TOKEN}",
        })
        self.assert_reply(response, 200, {"data": None, "revision": 0})
        response = self.request("OPTIONS", "/me/worklog", origin="https://localhost", headers={
            "access-control-request-method": "PUT",
            "access-control-request-headers": "x-worklog-authorization, content-type",
        })
        self.assert_reply(response, 204)
        self.assertIn("X-Worklog-Authorization", response["headers"]["Access-Control-Allow-Headers"])

    def test_disagreeing_bearer_headers_are_rejected(self):
        self.assert_reply(self.request("GET", "/admin/employees", token=ADMIN_TOKEN, headers={
            "X-Worklog-Authorization": f"Bearer {STAFF_TOKEN}",
        }), 401, {"error": "invalid_session"})

    def test_logout_revokes_using_expired_or_rotated_access_token(self):
        cases = (("expired", False), ("rotated", True))
        for reason, rotate in cases:
            with self.subTest(reason=reason):
                token = f"{reason}-access-synthetic-test-0123456789"
                refresh = token + "-refresh"
                self.store.run_write(lambda tx: tx.insert_session(Session(
                    reason, self.staff.uid, 0, digest(token), digest(refresh),
                    1_700_000_100 if rotate else 1_699_999_999, 1_700_000_200,
                )))
                if rotate:
                    refresh = self.service.renew(refresh)["refreshToken"]
                self.assert_reply(self.request("GET", "/me/worklog", token=token), 401,
                                  {"error": "invalid_session"})
                self.assert_reply(self.request("POST", "/auth/logout", token=token), 200, {})
                self.assert_reply(self.request("POST", "/auth/renew", {"refreshToken": refresh}), 401,
                                  {"error": "invalid_session"})
                self.assert_reply(self.request("POST", "/auth/logout", token=token), 401,
                                  {"error": "invalid_session"})

    def test_auth_limit_uses_gateway_source_ip(self):
        for attempt in range(100):
            forwarded = {"x-forwarded-for": f"198.51.100.{attempt + 1}", "x-real-ip": f"203.0.113.{attempt + 1}"}
            body = {"email": f"try-{attempt}@example.test", "password": "short", "invite": "bad"}
            self.assert_reply(self.request("POST", "/auth/register", body, headers=forwarded),
                              422, {"error": "invalid_password"})
        self.assert_reply(self.request("POST", "/auth/register", body, headers={"x-forwarded-for": "198.51.100.200"}),
                          429, {"error": "rate_limited"})
        self.assert_reply(self.request("POST", "/auth/login", {"email": body["email"], "password": "short"}),
                          401, {"error": "invalid_credentials"})
        self.assert_reply(self.request("POST", "/auth/register", body, ip=None, headers=forwarded),
                          401, {"error": "invalid_credentials"})

    def test_shared_ip_pilot_registers_and_signs_in_fifty_employees(self):
        expected = {}
        for index in range(50):
            email = f"pilot-{index}@example.test"
            invite = self.assert_reply(self.request("POST", "/admin/invites", {}, token=ADMIN_TOKEN), 200)
            credentials = {"email": email, "password": PASSWORD}
            registered = self.assert_reply(self.request("POST", "/auth/register", {
                **credentials, "invite": invite["code"],
            }), 200)
            self.assertEqual(registered["user"]["role"], "employee")
            logged_in = self.assert_reply(self.request("POST", "/auth/login", credentials), 200)
            self.assertEqual(logged_in["user"], registered["user"])
            uid = logged_in["user"]["uid"]
            token = logged_in["accessToken"]
            data = snapshot(str(index + 1))
            saved = self.assert_reply(self.request("PUT", "/me/worklog", {
                "data": data, "expectedRevision": 0, "mutationId": "pilot-save",
            }, token=token), 200)
            self.assertEqual(saved["revision"], 1)
            expected[uid] = {"profile": {"email": email}, "worklog": data}

        self.assertEqual(len(expected), 50)
        self.assert_reply(self.request("GET", "/me/worklog", token=token), 200,
                          {"data": data, "revision": 1})
        self.assert_reply(self.request("GET", "/admin/employees", token=token),
                          403, {"error": "forbidden"})

        expected[self.admin.uid] = {"profile": {"email": self.admin.email}, "worklog": None}
        expected[self.staff.uid] = {"profile": {"email": self.staff.email}, "worklog": None}
        seen = {}
        cursor = ""
        for _ in range(len(expected)):
            page = self.assert_reply(self.request("GET", "/admin/employees", token=ADMIN_TOKEN,
                                                  query={"cursor": cursor}), 200)
            self.assertFalse(seen.keys() & page["users"].keys())
            seen.update(page["users"])
            cursor = page.get("nextCursor")
            if cursor is None:
                break
        self.assertIsNone(cursor)
        self.assertEqual(seen, expected)

    def test_store_unavailability_is_generic(self):
        with patch.object(self.store, "run_read", side_effect=StoreUnavailable("connection secret")):
            response = self.request("GET", "/me/worklog", token=STAFF_TOKEN)
        self.assert_reply(response, 503, {"error": "service_unavailable"})

    def test_auth_lifecycle_uses_typed_fields(self):
        invite = self.service.create_invite(self.admin)
        registration = {"email": "register-life@example.test", "password": PASSWORD, "invite": invite["code"]}
        registered = self.assert_reply(self.request("POST", "/auth/register", registration), 200)
        login = self.assert_reply(self.request("POST", "/auth/login", {
            "email": registration["email"], "password": PASSWORD,
        }), 200)
        renewed = self.assert_reply(self.request("POST", "/auth/renew", {"refreshToken": login["refreshToken"]}), 200)
        self.assert_reply(self.request("POST", "/auth/logout", token=renewed["accessToken"]), 200, {})
        self.assert_reply(self.request("GET", "/me/worklog", token=renewed["accessToken"]), 401,
                          {"error": "invalid_session"})
        uid = registered["user"]["uid"]
        reset = self.assert_reply(self.request("POST", f"/admin/users/{uid}/reset", token=ADMIN_TOKEN), 200)
        self.assert_reply(self.request("POST", "/auth/reset", {
            "code": reset["code"], "newPassword": "synthetic changed password",
        }), 200, {})
        self.assert_reply(self.request("GET", "/me/worklog", token=registered["accessToken"]), 401,
                          {"error": "invalid_session"})
        self.assert_reply(self.request("DELETE", f"/admin/invites/{invite['id']}", token=ADMIN_TOKEN),
                          409, {"error": "invite_unavailable"})
