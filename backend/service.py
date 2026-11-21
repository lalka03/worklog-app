"""Account, invitation and session rules shared by the Worklog backend."""

import ipaddress
import json
import re
import time
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timezone
from typing import Callable, NotRequired, TypedDict
from uuid import UUID, uuid4

from . import security
from .store import (
    Account,
    AuditEvent,
    DuplicateAccountEmail,
    Invitation,
    Mutation,
    RateBin,
    Reset,
    Session,
    Store,
    Worklog,
)


ACCESS_SECONDS = 15 * 60
REFRESH_SECONDS = 7 * 24 * 60 * 60
REMEMBER_SECONDS = 30 * 24 * 60 * 60
INVITE_SECONDS = 7 * 24 * 60 * 60
RESET_SECONDS = 60 * 60
RATE_WINDOW = 15 * 60
RATE_IP_MAX = 100
RATE_EMAIL_MAX = 10
MAX_WORKLOG_BYTES = 512 * 1024
EMPLOYEE_PAGE_SIZE = 3
MAX_REVISION = 2**53 - 1
MAX_SHIFT_HOURS = 168
MAX_SETTING_VALUE = 1_000_000
MAX_RATE = 1_000_000_000

_MUTATION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}", re.ASCII)
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_TIME = re.compile(r"(?:[01]?[0-9]|2[0-3]):[0-5]?[0-9]")


class DomainError(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.code = code
        self.status = status


class User(TypedDict):
    uid: str
    email: str
    role: str


@dataclass(frozen=True)
class Principal:
    uid: str
    email: str
    role: str
    _access_digest: str | None = field(default=None, repr=False, compare=False)


class AuthResult(TypedDict):
    user: User
    accessToken: str
    refreshToken: str
    expiresAt: str


class InviteResult(TypedDict):
    id: str
    code: str
    expiresAt: str


class ResetResult(TypedDict):
    code: str
    expiresAt: str


class WorklogSnapshot(TypedDict):
    data: dict | None
    revision: int


class WorklogSave(TypedDict):
    revision: int
    updatedAt: str


class EmployeeProfile(TypedDict):
    email: str


class Employee(TypedDict):
    profile: EmployeeProfile
    worklog: dict | None


class EmployeePage(TypedDict):
    users: dict[str, Employee]
    nextCursor: NotRequired[str]


def utc_timestamp(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


def _id():
    return str(uuid4())


def _valid_uid(value):
    try:
        return isinstance(value, str) and len(value) == 36 and str(UUID(value)) == value
    except ValueError:
        return False


def _worklog_required(condition):
    if not condition:
        raise DomainError("invalid_worklog", 422)


def _validate_date(value):
    _worklog_required(isinstance(value, str) and _DATE.fullmatch(value))
    try:
        date.fromisoformat(value)
    except ValueError:
        raise DomainError("invalid_worklog", 422) from None


def _bounded_number(value, maximum):
    # Existing WebView forms and exports may represent numbers as strings.
    if isinstance(value, str):
        _worklog_required(len(value) <= 64 and _DECIMAL.fullmatch(value.strip()))
        value = float(value)
    _worklog_required(type(value) in (int, float) and 0 <= value <= maximum)
    return value


def _validate_shift(block):
    if block is None:
        return
    _worklog_required(
        isinstance(block, dict) and {"hours", "route"} <= block.keys() <= {"hours", "route", "departure", "after"}
    )
    _bounded_number(block["hours"], MAX_SHIFT_HOURS)
    _worklog_required(_bounded_number(block["route"], 3) in (1, 2, 3))
    departure = block.get("departure", "")
    _worklog_required(
        isinstance(departure, str) and len(departure) <= 16 and
        (not departure.strip() or _TIME.fullmatch(departure.strip()))
    )
    _worklog_required(type(block.get("after", False)) is bool)


def _validate_worklog(data):
    _worklog_required(isinstance(data, dict) and data.keys() == {"days", "settings", "version"})
    _worklog_required(type(data["version"]) is int and data["version"] == 1)
    settings = data["settings"]
    _worklog_required(
        isinstance(settings, dict) and settings.keys() == {"anchor", "coef", "p1", "p2", "p3", "rates", "th1", "th2"}
    )
    _validate_date(settings["anchor"])
    cycle = [_bounded_number(settings[key], MAX_SETTING_VALUE) for key in ("p1", "p2", "p3")]
    _worklog_required(sum(cycle) > 0)
    for key in ("th1", "th2", "coef"):
        _bounded_number(settings[key], MAX_SETTING_VALUE)
    rates = settings["rates"]
    _worklog_required(isinstance(rates, dict) and rates.keys() == {"1", "2", "3"})
    for rate in rates.values():
        _bounded_number(rate, MAX_RATE)

    days = data["days"]
    _worklog_required(isinstance(days, dict))
    for key, day in days.items():
        _validate_date(key)
        _worklog_required(
            isinstance(day, dict) and day.keys() <= {"date", "main", "pod"} and day.get("date") == key
        )
        _validate_shift(day.get("main"))
        pod = day.get("pod")
        if pod is not None:
            _worklog_required(isinstance(pod, dict) and pod.keys() <= {"s1", "s2"})
            for block in pod.values():
                _validate_shift(block)


def _worklog_json(data):
    _validate_worklog(data)
    try:
        encoded = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        _worklog_required(len(encoded.encode("utf-8")) <= MAX_WORKLOG_BYTES)
    except (ValueError, UnicodeError, RecursionError):
        raise DomainError("invalid_worklog", 422) from None
    return encoded


def _source_ip(ip):
    try:
        if not isinstance(ip, str):
            raise ValueError("missing source address")
        address = ipaddress.ip_address(ip)
        if isinstance(address, ipaddress.IPv6Address):
            if address.scope_id:
                raise ValueError("expected unscoped source address")
            address = address.ipv4_mapped or address
    except ValueError:
        raise DomainError("invalid_credentials", 401) from None
    return str(address)


def _employee(tx, account):
    worklog = tx.get_worklog(account.uid)
    return Employee(profile=EmployeeProfile(email=account.email), worklog=worklog.data if worklog else None)


def _audit(tx, action, actor_uid, target_id, now):
    tx.put_audit(AuditEvent(_id(), action, actor_uid, target_id, now))


def _invite_state(invite, now):
    if invite.state == "available" and invite.expires_at <= now:
        return "expired"
    return invite.state


def _require_available_invite(tx, digest, now):
    invite = tx.get_invitation(digest)
    if invite is None or _invite_state(invite, now) != "available":
        raise DomainError("invalid_invite", 422)
    return invite


def _issue_invite(tx, action, issuer_uid, code, now):
    invitation = Invitation(security.digest(code), _id(), issuer_uid, now, now + INVITE_SECONDS, "available")
    tx.insert_invitation(invitation)
    _audit(tx, action, issuer_uid, invitation.id, now)
    return InviteResult(id=invitation.id, code=code, expiresAt=utc_timestamp(invitation.expires_at))


def _account_generation_matches(account, generation):
    return account is not None and account.enabled and account.session_generation == generation


def _auth_result(account, access, refresh, session):
    return AuthResult(
        user=User(uid=account.uid, email=account.email, role=account.role),
        accessToken=access, refreshToken=refresh,
        expiresAt=utc_timestamp(session.access_expires_at),
    )


def _insert_session(tx, account, access, refresh, now, *, remember=False):
    session = Session(
        _id(), account.uid, account.session_generation, security.digest(access), security.digest(refresh),
        now + ACCESS_SECONDS, now + (REMEMBER_SECONDS if remember else REFRESH_SECONDS),
    )
    tx.insert_session(session)
    return _auth_result(account, access, refresh, session)


def seed_owner_invite(
    store: Store, clock: Callable[[], float] = time.time, tokens: Callable[[], str] = security.new_token,
) -> InviteResult:
    """Privileged setup only: issue or replace an unredeemed bootstrap invitation."""
    code = tokens()

    def seed(tx):
        if tx.list_accounts("", 1):
            raise DomainError("bootstrap_unavailable", 409)
        invites = tx.list_invitations()
        if any(invite.issuer_uid or invite.state not in ("available", "revoked") for invite in invites):
            raise DomainError("bootstrap_unavailable", 409)

        now = int(clock())
        for invite in invites:
            if invite.state == "available":
                tx.update_invitation(replace(invite, state="revoked"))
                _audit(tx, "bootstrap_invite_revoked", "", invite.id, now)
        return _issue_invite(tx, "bootstrap_invite_created", "", code, now)

    return store.run_write(seed)


def promote_owner(store: Store, uid: str, invite_id: str, clock: Callable[[], float] = time.time) -> None:
    """Privileged setup only: promote the verified consumer of the specified bootstrap invitation."""
    def promote(tx):
        accounts = tx.list_accounts("", 2)
        if len(accounts) != 1 or accounts[0].uid != uid:
            raise DomainError("bootstrap_unavailable", 409)
        account = accounts[0]
        if not account.enabled or account.role != "employee":
            raise DomainError("bootstrap_unavailable", 409)
        active_history = [
            invite for invite in tx.list_invitations() if not invite.issuer_uid and invite.state != "revoked"
        ]
        if len(active_history) != 1:
            raise DomainError("bootstrap_unavailable", 409)
        invite = active_history[0]
        if invite.id != invite_id or invite.state != "used" or invite.consumed_by != uid:
            raise DomainError("bootstrap_unavailable", 409)
        tx.promote_account(uid, account.session_generation + 1)
        _audit(tx, "owner_promoted", "", uid, int(clock()))

    store.run_write(promote)


class Service:
    def __init__(
        self, store: Store, clock: Callable[[], float] = time.time, tokens: Callable[[], str] = security.new_token,
    ):
        self.store = store
        self.clock = clock
        self.tokens = tokens

    def _now(self):
        return int(self.clock())

    def _account_for_access(self, tx, digest):
        session = tx.get_session_by_access(digest)
        if session is None or session.access_digest != digest or session.access_expires_at <= self._now():
            raise DomainError("invalid_session", 401)
        account = tx.get_account(session.uid)
        if not _account_generation_matches(account, session.generation):
            raise DomainError("invalid_session", 401)
        return account

    def _require_authenticated_account(self, tx, principal):
        # Check the same bearer again inside the transaction that reads or changes data.
        if not isinstance(principal, Principal) or not isinstance(principal._access_digest, str):
            raise DomainError("invalid_session", 401)
        account = self._account_for_access(tx, principal._access_digest)
        if account.uid != principal.uid:
            raise DomainError("invalid_session", 401)
        return account

    def _require_admin(self, tx, principal):
        account = self._require_authenticated_account(tx, principal)
        if account.role != "admin":
            raise DomainError("forbidden", 403)
        return account

    def register(self, email: str, password: str, invite: str) -> AuthResult:
        normalized = security.normalize_email(email)
        if normalized is None:
            raise DomainError("invalid_email", 422)
        if not security.valid_password(password):
            raise DomainError("invalid_password", 422)
        digest = security.credential_digest(invite)
        if digest is None:
            raise DomainError("invalid_invite", 422)

        # Reject invalid invitation guesses before the expensive password hash.
        self.store.run_read(lambda tx: _require_available_invite(tx, digest, self._now()))
        password_hash = security.hash_password(password)
        uid, access, refresh = _id(), self.tokens(), self.tokens()

        def register(tx):
            now = self._now()
            invitation = _require_available_invite(tx, digest, now)
            account = Account(uid, normalized, password_hash, "employee", True, now, 0)
            tx.insert_account(account)
            tx.update_invitation(replace(invitation, state="used", consumed_by=uid))
            _audit(tx, "account_registered", uid, invitation.id, now)
            return _insert_session(tx, account, access, refresh, now)

        try:
            return self.store.run_write(register)
        except DuplicateAccountEmail:
            raise DomainError("invalid_invite", 422) from None

    def charge_auth_attempt(self, ip, *, scope="", email=None):
        namespace = scope + ":" if scope else ""
        limits = [(security.digest(namespace + "ip:" + _source_ip(ip)), RATE_IP_MAX)]
        normalized_email = security.normalize_email(email)
        if normalized_email is not None:
            limits.append((security.digest(namespace + "email:" + normalized_email), RATE_EMAIL_MAX))

        def charge(tx):
            now = self._now()
            updates = []
            for key, limit in limits:
                row = tx.get_rate_bin(key)
                history = row.attempts if row else ()
                attempts = tuple(attempt for attempt in history if attempt > now - RATE_WINDOW)
                if len(attempts) >= limit:
                    raise DomainError("rate_limited", 429)
                updates.append(RateBin(key, (*attempts, now), now + RATE_WINDOW))
            for rate_bin in updates:
                tx.put_rate_bin(rate_bin)

        # Credentials are checked after this transaction commits. Wrong passwords still count.
        self.store.run_write(charge)

    def login(self, email: str, password: str, ip: str, *, remember: bool = False) -> AuthResult:
        if type(remember) is not bool:
            raise DomainError("invalid_request", 422)
        self.charge_auth_attempt(ip, email=email)
        normalized = security.normalize_email(email)
        if normalized is None or not security.valid_password(password):
            raise DomainError("invalid_credentials", 401)

        account = self.store.run_read(lambda tx: tx.get_account_by_email(normalized))
        encoded = account.password_hash if account and account.enabled else security.DUMMY_PASSWORD_HASH
        verified = security.verify_password(encoded, password)
        if account is None or not account.enabled or not verified:
            raise DomainError("invalid_credentials", 401)
        access, refresh = self.tokens(), self.tokens()

        def login(tx):
            current = tx.get_account(account.uid)
            if current is None or not current.enabled or current.password_hash != encoded:
                raise DomainError("invalid_credentials", 401)
            return _insert_session(tx, current, access, refresh, self._now(), remember=remember)

        return self.store.run_write(login)

    def authenticate(self, access_token: str) -> Principal:
        digest = security.credential_digest(access_token)
        if digest is None:
            raise DomainError("invalid_session", 401)

        def authenticate(tx):
            account = self._account_for_access(tx, digest)
            return Principal(account.uid, account.email, account.role, _access_digest=digest)

        return self.store.run_read(authenticate)

    def renew(self, refresh_token: str) -> AuthResult:
        digest = security.credential_digest(refresh_token)
        if digest is None:
            raise DomainError("invalid_session", 401)
        access, refresh = self.tokens(), self.tokens()

        def renew(tx):
            session = tx.get_session_by_refresh(digest)
            now = self._now()
            if session is None or session.refresh_digest != digest or session.refresh_expires_at <= now:
                raise DomainError("invalid_session", 401)
            account = tx.get_account(session.uid)
            if not _account_generation_matches(account, session.generation):
                raise DomainError("invalid_session", 401)
            updated = replace(
                session, access_digest=security.digest(access), refresh_digest=security.digest(refresh),
                access_expires_at=min(now + ACCESS_SECONDS, session.refresh_expires_at),
            )
            tx.rotate_session(session, updated)
            return _auth_result(account, access, refresh, updated)

        return self.store.run_write(renew)

    def logout(self, access_token: str, *, require_session: bool = False) -> None:
        digest = security.credential_digest(access_token)
        if digest is None:
            if require_session:
                raise DomainError("invalid_session", 401)
            return

        def logout(tx):
            session = tx.get_session_by_access(digest)
            if require_session and (
                session is None or session.refresh_expires_at <= self._now() or
                not _account_generation_matches(tx.get_account(session.uid), session.generation)
            ):
                raise DomainError("invalid_session", 401)
            # An expired or rotated access token can still revoke its session.
            if session is not None:
                tx.delete_session(session)

        self.store.run_write(logout)

    def create_invite(self, principal: Principal) -> InviteResult:
        code = self.tokens()

        def create(tx):
            actor = self._require_admin(tx, principal)
            return _issue_invite(tx, "invitation_created", actor.uid, code, self._now())

        return self.store.run_write(create)

    def list_invites(self, principal: Principal) -> dict:
        def list_invites(tx):
            self._require_admin(tx, principal)
            now = self._now()
            return {"invites": [
                {
                    "id": invitation.id, "issuerUid": invitation.issuer_uid,
                    "createdAt": utc_timestamp(invitation.created_at),
                    "expiresAt": utc_timestamp(invitation.expires_at), "state": _invite_state(invitation, now),
                }
                for invitation in tx.list_invitations()
            ]}

        return self.store.run_read(list_invites)

    def revoke_invite(self, principal: Principal, invite_id: str) -> None:
        def revoke(tx):
            actor = self._require_admin(tx, principal)
            invitation = tx.get_invitation_by_id(invite_id)
            if invitation is None:
                raise DomainError("not_found", 404)
            if invitation.state == "revoked":
                return
            now = self._now()
            if _invite_state(invitation, now) != "available":
                raise DomainError("invite_unavailable", 409)
            tx.update_invitation(replace(invitation, state="revoked"))
            _audit(tx, "invitation_revoked", actor.uid, invite_id, now)

        self.store.run_write(revoke)

    def issue_reset(self, principal: Principal, uid: str) -> ResetResult:
        code = self.tokens()

        def issue(tx):
            actor = self._require_admin(tx, principal)
            account = tx.get_account(uid)
            if account is None or not account.enabled:
                raise DomainError("not_found", 404)
            now = self._now()
            reset = Reset(security.digest(code), uid, actor.uid, account.session_generation, now + RESET_SECONDS)
            tx.insert_reset(reset)
            _audit(tx, "password_reset_issued", actor.uid, uid, now)
            return ResetResult(code=code, expiresAt=utc_timestamp(reset.expires_at))

        return self.store.run_write(issue)

    def _find_reset(self, tx, digest):
        reset = tx.get_reset(digest)
        if reset is None or reset.used or reset.expires_at <= self._now():
            raise DomainError("invalid_reset", 422)
        account = tx.get_account(reset.uid)
        if not _account_generation_matches(account, reset.generation):
            raise DomainError("invalid_reset", 422)
        return account

    def redeem_reset(self, code: str, new_password: str) -> None:
        if not security.valid_password(new_password):
            raise DomainError("invalid_password", 422)
        digest = security.credential_digest(code)
        if digest is None:
            raise DomainError("invalid_reset", 422)
        self.store.run_read(lambda tx: self._find_reset(tx, digest))
        encoded = security.hash_password(new_password)

        def redeem(tx):
            account = self._find_reset(tx, digest)
            tx.update_account_security(replace(
                account, password_hash=encoded, session_generation=account.session_generation + 1,
            ))
            tx.mark_reset_used(digest)
            _audit(tx, "password_reset_redeemed", account.uid, account.uid, self._now())

        self.store.run_write(redeem)

    def get_worklog(self, principal: Principal) -> WorklogSnapshot:
        def read(tx):
            account = self._require_authenticated_account(tx, principal)
            worklog = tx.get_worklog(account.uid)
            if worklog is None:
                return WorklogSnapshot(data=None, revision=0)
            return WorklogSnapshot(data=worklog.data, revision=worklog.revision)

        return self.store.run_read(read)

    def put_worklog(self, principal: Principal, data: dict, expected_revision: int, mutation_id: str) -> WorklogSave:
        if type(expected_revision) is not int or not 0 <= expected_revision <= MAX_REVISION:
            raise DomainError("invalid_revision", 422)
        if not isinstance(mutation_id, str) or not _MUTATION_ID.fullmatch(mutation_id):
            raise DomainError("invalid_mutation", 422)
        encoded = _worklog_json(data)
        request_digest = security.digest(f"{expected_revision}:{encoded}")
        snapshot = json.loads(encoded)

        def save(tx):
            uid = self._require_authenticated_account(tx, principal).uid
            previous = tx.get_mutation(uid, mutation_id)
            if previous is not None:
                if previous.request_digest != request_digest:
                    raise DomainError("mutation_mismatch", 409)
                return WorklogSave(revision=previous.revision, updatedAt=utc_timestamp(previous.updated_at))

            current = tx.get_worklog(uid)
            revision = current.revision if current else 0
            if revision != expected_revision:
                raise DomainError("stale_revision", 409)
            if revision == MAX_REVISION:
                raise DomainError("revision_limit", 409)

            revision += 1
            now = self._now()
            tx.put_worklog(Worklog(uid, snapshot, revision, now))
            tx.put_mutation(Mutation(uid, mutation_id, request_digest, revision, now))
            _audit(tx, "worklog_updated", uid, uid, now)
            return WorklogSave(revision=revision, updatedAt=utc_timestamp(now))

        return self.store.run_write(save)

    def list_employees(self, principal: Principal, cursor: str = "") -> EmployeePage:
        def list_page(tx):
            self._require_admin(tx, principal)
            if cursor != "" and not _valid_uid(cursor):
                raise DomainError("invalid_cursor", 422)
            accounts = tx.list_accounts(cursor, EMPLOYEE_PAGE_SIZE + 1)
            page = accounts[:EMPLOYEE_PAGE_SIZE]
            result = EmployeePage(users={account.uid: _employee(tx, account) for account in page if account.enabled})
            if len(accounts) > EMPLOYEE_PAGE_SIZE:
                result["nextCursor"] = page[-1].uid
            return result

        return self.store.run_read(list_page)

    def get_employee(self, principal: Principal, uid: str) -> Employee:
        def read(tx):
            self._require_admin(tx, principal)
            account = tx.get_account(uid) if _valid_uid(uid) else None
            if account is None or not account.enabled:
                raise DomainError("not_found", 404)
            return _employee(tx, account)

        return self.store.run_read(read)
