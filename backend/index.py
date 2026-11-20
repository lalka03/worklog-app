"""Private Cloud Functions HTTP handler for Yandex API Gateway payload v2.0."""

import base64
import binascii
import json
import math
import os
import re
from threading import Lock

import ydb
import ydb.iam

from .service import MAX_WORKLOG_BYTES, DomainError, Service
from .store import StoreUnavailable, YdbStore


_ORIGINS = {"https://localhost", "http://localhost"}
_CORS_HEADER_NAMES = ("Authorization", "Content-Type", "X-Worklog-Authorization")
_CORS_HEADERS = {name.lower() for name in _CORS_HEADER_NAMES}
_BEARER = re.compile(r"Bearer +([A-Za-z0-9_-]{22,128})", re.IGNORECASE | re.ASCII)

_ROUTES = (
    (re.compile(r"/auth/(register|login|renew|logout|reset)"), {"POST"}),
    (re.compile(r"/me/worklog"), {"GET", "PUT"}),
    (re.compile(r"/admin/employees"), {"GET"}),
    (re.compile(r"/admin/employees/([A-Za-z0-9_-]{1,128})"), {"GET"}),
    (re.compile(r"/admin/invites"), {"GET", "POST"}),
    (re.compile(r"/admin/invites/([A-Za-z0-9_-]{1,128})"), {"DELETE"}),
    (re.compile(r"/admin/users/([A-Za-z0-9_-]{1,128})/reset"), {"POST"}),
)
_AUTH_FIELDS = {
    "register": {"email", "password", "invite"},
    "login": {"email", "password"},
    "renew": {"refreshToken"},
    "reset": {"code", "newPassword"},
}

_service = None
_service_lock = Lock()


def _get_service():
    global _service
    with _service_lock:
        if _service is None:
            try:
                endpoint = os.environ["WORKLOG_YDB_ENDPOINT"]
                database = os.environ["WORKLOG_YDB_DATABASE"]
                credentials = ydb.iam.MetadataUrlCredentials()
                _service = Service(YdbStore.connect(endpoint, database, credentials))
            except (KeyError, ValueError, ydb.Error, TimeoutError, OSError):
                raise StoreUnavailable("YDB initialization failed") from None
        return _service


def _respond(status, payload, origin=None, extra=None):
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin"}
    if origin in _ORIGINS:
        headers["Access-Control-Allow-Origin"] = origin
    if extra is not None:
        headers.update(extra)
    return {
        "statusCode": status, "headers": headers, "isBase64Encoded": False,
        "body": json.dumps(payload, separators=(",", ":"), ensure_ascii=False) if payload is not None else "",
    }


def _invalid_request():
    return DomainError("invalid_request", 422)


def _request(event):
    if not isinstance(event, dict) or event.get("version") != "2.0":
        raise _invalid_request()
    context = event.get("requestContext")
    http = context.get("http") if isinstance(context, dict) else None
    method = http.get("method") if isinstance(http, dict) else None
    path = event.get("rawPath")
    raw_headers = event.get("headers") or {}
    if not isinstance(method, str) or not isinstance(path, str) or not isinstance(raw_headers, dict):
        raise _invalid_request()
    headers = {}
    for key, value in raw_headers.items():
        if not isinstance(key, str) or not isinstance(value, str) or key.lower() in headers:
            raise _invalid_request()
        headers[key.lower()] = value
    # API Gateway constructs requestContext. Forwarding headers and query data are caller-controlled.
    return method, path, headers, http.get("sourceIp")


def _match_route(path):
    for pattern, methods in _ROUTES:
        match = pattern.fullmatch(path)
        if match:
            return match.group(1) if match.groups() else None, methods
    raise DomainError("not_found", 404)


def _preflight(headers, origin, methods):
    requested = headers.get("access-control-request-method")
    requested_headers = headers.get("access-control-request-headers", "")
    names = {part.strip().lower() for part in requested_headers.split(",") if part.strip()}
    if origin is None or requested not in methods or not names <= _CORS_HEADERS:
        raise DomainError("invalid_preflight", 403)
    return _respond(204, None, origin, {
        "Access-Control-Allow-Methods": ", ".join(sorted(methods)),
        "Access-Control-Allow-Headers": ", ".join(_CORS_HEADER_NAMES),
        "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    })


def _json_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate JSON key")
    return result


def _json_number(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("nonfinite JSON number")
    return number


def _read_body(event, headers, fields):
    body = event.get("body")
    if body is None or body == "":
        if fields:
            raise _invalid_request()
        return {}
    content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if not isinstance(body, str) or content_type != "application/json":
        raise _invalid_request()

    try:
        if event.get("isBase64Encoded") is True:
            if len(body) > ((MAX_WORKLOG_BYTES + 2) // 3) * 4:
                raise ValueError("body too large")
            data = base64.b64decode(body, validate=True)
        else:
            if len(body) > MAX_WORKLOG_BYTES:
                raise ValueError("body too large")
            data = body.encode("utf-8")
        if len(data) > MAX_WORKLOG_BYTES:
            raise ValueError("body too large")
        result = json.loads(
            data.decode("utf-8"), object_pairs_hook=_json_object, parse_float=_json_number, parse_constant=_json_number,
        )
    except (ValueError, UnicodeError, binascii.Error, RecursionError):
        raise _invalid_request() from None

    if not isinstance(result, dict) or result.keys() != fields:
        raise _invalid_request()
    return result


def _read_query(event, path):
    params = event.get("queryStringParameters")
    if params is None:
        return ""
    if not isinstance(params, dict) or params.keys() - ({"cursor"} if path == "/admin/employees" else set()):
        raise _invalid_request()
    return params.get("cursor", "")


def _access_token(headers):
    # Direct Cloud Functions HTTPS filters Authorization. The private gateway
    # uses a Worklog-specific header to carry the application bearer token.
    matches = [
        _BEARER.fullmatch(headers[name])
        for name in ("x-worklog-authorization", "authorization") if name in headers
    ]
    tokens = {match.group(1) if match else None for match in matches}
    if len(tokens) != 1 or None in tokens:
        raise DomainError("invalid_session", 401)
    return tokens.pop()


def _public_auth(service, action, body, ip):
    if action == "login":
        return service.login(body["email"], body["password"], ip)
    service.charge_auth_attempt(ip, scope=action, email=body.get("email"))
    if action == "register":
        return service.register(body["email"], body["password"], body["invite"])
    if action == "renew":
        return service.renew(body["refreshToken"])
    service.redeem_reset(body["code"], body["newPassword"])
    return {}


def _dispatch(event, method, path, argument, headers, ip, service):
    if path.startswith("/auth/") and argument in _AUTH_FIELDS:
        _read_query(event, path)
        body = _read_body(event, headers, _AUTH_FIELDS[argument])
        return _public_auth(service or _get_service(), argument, body, ip)

    token = _access_token(headers)
    service = service or _get_service()
    if path == "/auth/logout":
        _read_query(event, path)
        _read_body(event, headers, set())
        service.logout(token, require_session=True)
        return {}

    principal = service.authenticate(token)
    if path.startswith("/admin/") and principal.role != "admin":
        raise DomainError("forbidden", 403)

    cursor = _read_query(event, path)
    if method == "PUT":  # /me/worklog is the only write route that accepts a snapshot.
        body = _read_body(event, headers, {"data", "expectedRevision", "mutationId"})
        return service.put_worklog(principal, body["data"], body["expectedRevision"], body["mutationId"])

    _read_body(event, headers, set())
    if path == "/me/worklog":
        return service.get_worklog(principal)
    if path == "/admin/employees":
        return service.list_employees(principal, cursor)
    if path.startswith("/admin/employees/"):
        return service.get_employee(principal, argument)
    if path == "/admin/invites":
        return service.list_invites(principal) if method == "GET" else service.create_invite(principal)
    if path.startswith("/admin/invites/"):
        service.revoke_invite(principal, argument)
        return {}
    if path.startswith("/admin/users/") and path.endswith("/reset"):
        return service.issue_reset(principal, argument)
    raise DomainError("not_found", 404)


def handle(event, service=None):
    origin = None
    try:
        method, path, headers, ip = _request(event)
        origin = headers.get("origin")
        if origin is not None and origin not in _ORIGINS:
            raise DomainError("origin_forbidden", 403)
        argument, methods = _match_route(path)
        if method == "OPTIONS":
            return _preflight(headers, origin, methods)
        if method not in methods:
            return _respond(405, {"error": "method_not_allowed"}, origin, {
                "Allow": ", ".join(sorted(methods | {"OPTIONS"})),
            })
        return _respond(200, _dispatch(event, method, path, argument, headers, ip, service), origin)
    except DomainError as error:
        return _respond(error.status, {"error": error.code}, origin)
    except StoreUnavailable:
        return _respond(503, {"error": "service_unavailable"}, origin)
    except Exception:
        return _respond(500, {"error": "internal_error"}, origin)


def handler(event, context):
    return handle(event)
