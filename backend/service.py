"""Account, invitation and session rules shared by the Worklog backend."""

import ipaddress
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Callable, TypedDict
from uuid import uuid4

from . import security
from .store import (
    Account,
    AuditEvent,
    DuplicateAccountEmail,
    Invitation,
    RateBin,
    Reset,
    Session,
    Store,
)


ACCESS_SECONDS = 15 * 60
REFRESH_SECONDS = 7 * 24 * 60 * 60
INVITE_SECONDS = 7 * 24 * 60 * 60
RESET_SECONDS = 60 * 60
RATE_WINDOW = 15 * 60
RATE_MAX = 10


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


def utc_timestamp(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


def _id():
    return str(uuid4())


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


def _principal(account):
    return Principal(account.uid, account.email, account.role)


def _auth_result(account, access, refresh, session):
    return AuthResult(
        user=User(uid=account.uid, email=account.email, role=account.role),
        accessToken=access, refreshToken=refresh,
        expiresAt=utc_timestamp(session.access_expires_at),
    )


def _insert_session(tx, account, access, refresh, now):
    session = Session(
        _id(), account.uid, account.session_generation, security.digest(access), security.digest(refresh),
        now + ACCESS_SECONDS, now + REFRESH_SECONDS,
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

    def _require_admin(self, tx, principal):
        account = tx.get_account(principal.uid)
        if principal.role != "admin" or account is None or not account.enabled or account.role != "admin":
            raise DomainError("forbidden", 403)

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

    def _charge_login(self, normalized_email, ip):
        keys = [security.digest("ip:" + ip)]
        if normalized_email is not None:
            keys.append(security.digest("email:" + normalized_email))

        def charge(tx):
            now = self._now()
            updates = []
            for key in keys:
                row = tx.get_rate_bin(key)
                history = row.attempts if row else ()
                attempts = tuple(attempt for attempt in history if attempt > now - RATE_WINDOW)
                if len(attempts) >= RATE_MAX:
                    raise DomainError("rate_limited", 429)
                updates.append(RateBin(key, (*attempts, now), now + RATE_WINDOW))
            for rate_bin in updates:
                tx.put_rate_bin(rate_bin)

        # Credentials are checked after this transaction commits. Wrong passwords still count.
        self.store.run_write(charge)

    def login(self, email: str, password: str, ip: str) -> AuthResult:
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
        normalized = security.normalize_email(email)
        self._charge_login(normalized, str(address))
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
            return _insert_session(tx, current, access, refresh, self._now())

        return self.store.run_write(login)

    def authenticate(self, access_token: str) -> Principal:
        digest = security.credential_digest(access_token)
        if digest is None:
            raise DomainError("invalid_session", 401)

        def authenticate(tx):
            session = tx.get_session_by_access(digest)
            if session is None or session.access_digest != digest or session.access_expires_at <= self._now():
                raise DomainError("invalid_session", 401)
            account = tx.get_account(session.uid)
            if not _account_generation_matches(account, session.generation):
                raise DomainError("invalid_session", 401)
            return _principal(account)

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

    def logout(self, access_token: str) -> None:
        digest = security.credential_digest(access_token)
        if digest is None:
            return

        def logout(tx):
            session = tx.get_session_by_access(digest)
            if session is not None:
                tx.delete_session(session)

        self.store.run_write(logout)

    def create_invite(self, principal: Principal) -> InviteResult:
        code = self.tokens()

        def create(tx):
            self._require_admin(tx, principal)
            return _issue_invite(tx, "invitation_created", principal.uid, code, self._now())

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
            self._require_admin(tx, principal)
            invitation = tx.get_invitation_by_id(invite_id)
            if invitation is None:
                raise DomainError("not_found", 404)
            if invitation.state == "revoked":
                return
            now = self._now()
            if _invite_state(invitation, now) != "available":
                raise DomainError("invite_unavailable", 409)
            tx.update_invitation(replace(invitation, state="revoked"))
            _audit(tx, "invitation_revoked", principal.uid, invite_id, now)

        self.store.run_write(revoke)

    def issue_reset(self, principal: Principal, uid: str) -> ResetResult:
        code = self.tokens()

        def issue(tx):
            self._require_admin(tx, principal)
            account = tx.get_account(uid)
            if account is None or not account.enabled:
                raise DomainError("not_found", 404)
            now = self._now()
            reset = Reset(security.digest(code), uid, principal.uid, account.session_generation, now + RESET_SECONDS)
            tx.insert_reset(reset)
            _audit(tx, "password_reset_issued", principal.uid, uid, now)
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
