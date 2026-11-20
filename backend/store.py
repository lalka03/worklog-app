"""Typed transactional storage for the Worklog backend."""

import json
from dataclasses import asdict, dataclass, fields
from typing import Callable, Protocol, TypeVar

import ydb

from .security import digest


@dataclass(frozen=True)
class Account:
    uid: str
    email: str
    password_hash: str
    role: str
    enabled: bool
    created_at: int
    session_generation: int


@dataclass(frozen=True)
class Invitation:
    digest: str
    id: str
    issuer_uid: str
    created_at: int
    expires_at: int
    state: str
    consumed_by: str = ""


@dataclass(frozen=True)
class Session:
    id: str
    uid: str
    generation: int
    access_digest: str
    refresh_digest: str
    access_expires_at: int
    refresh_expires_at: int


@dataclass(frozen=True)
class Reset:
    digest: str
    uid: str
    issuer_uid: str
    generation: int
    expires_at: int
    used: bool = False


@dataclass(frozen=True)
class RateBin:
    rate_key: str
    attempts: tuple[int, ...]
    expires_at: int


@dataclass(frozen=True)
class Worklog:
    uid: str
    data: dict
    revision: int
    updated_at: int


@dataclass(frozen=True)
class Mutation:
    uid: str
    mutation_id: str
    request_digest: str
    revision: int
    updated_at: int


@dataclass(frozen=True)
class AuditEvent:
    id: str
    action: str
    actor_uid: str
    target_id: str
    created_at: int


# This allowlist also defines the logical backup format and scan order.
BACKUP_TABLES = {
    "accounts": (Account, ("uid",)),
    "invitations": (Invitation, ("digest",)),
    "worklogs": (Worklog, ("uid",)),
    "mutations": (Mutation, ("uid", "mutation_id")),
    "audit_events": (AuditEvent, ("id",)),
}
_RESTORE_ONLY_TABLES = ("account_emails", "sessions", "session_access", "session_refresh", "reset_tokens", "rate_bins")


class DuplicateAccountEmail(Exception):
    pass


class StoreUnavailable(Exception):
    pass


class Transaction(Protocol):
    def backup_page(self, table: str, after: tuple[str, ...], limit: int) -> list: ...
    def backup_target_empty(self) -> bool: ...
    def insert_backup_page(self, table: str, records: list) -> None: ...

    def get_account(self, uid: str) -> Account | None: ...
    def get_account_by_email(self, email: str) -> Account | None: ...
    def list_accounts(self, after_uid: str, limit: int) -> list[Account]: ...
    def insert_account(self, account: Account) -> None: ...
    def update_account_security(self, account: Account) -> None: ...
    def promote_account(self, uid: str, session_generation: int) -> None: ...

    def get_invitation(self, digest: str) -> Invitation | None: ...
    def get_invitation_by_id(self, invitation_id: str) -> Invitation | None: ...
    def list_invitations(self) -> list[Invitation]: ...
    def insert_invitation(self, invitation: Invitation) -> None: ...
    def update_invitation(self, invitation: Invitation) -> None: ...

    def get_session_by_access(self, digest: str) -> Session | None: ...
    def get_session_by_refresh(self, digest: str) -> Session | None: ...
    def insert_session(self, session: Session) -> None: ...
    def rotate_session(self, previous: Session, current: Session) -> None: ...
    def delete_session(self, session: Session) -> None: ...

    def get_reset(self, digest: str) -> Reset | None: ...
    def insert_reset(self, reset: Reset) -> None: ...
    def mark_reset_used(self, digest: str) -> None: ...

    def get_rate_bin(self, key: str) -> RateBin | None: ...
    def put_rate_bin(self, rate_bin: RateBin) -> None: ...
    def get_worklog(self, uid: str) -> Worklog | None: ...
    def put_worklog(self, worklog: Worklog) -> None: ...
    def get_mutation(self, uid: str, mutation_id: str) -> Mutation | None: ...
    def put_mutation(self, mutation: Mutation) -> None: ...
    def put_audit(self, audit: AuditEvent) -> None: ...


T = TypeVar("T")


class Store(Protocol):
    """Transaction callbacks can be replayed and must have no external side effects."""

    def run_read(self, fn: Callable[[Transaction], T]) -> T: ...
    def run_write(self, fn: Callable[[Transaction], T]) -> T: ...


class YdbStore:
    """A shared SDK session pool, with a fresh transaction for each retry."""

    def __init__(self, driver, database):
        self.database = database
        self._driver = driver
        self._pool = ydb.QuerySessionPool(driver, size=8)

    @classmethod
    def connect(cls, endpoint, database, credentials=None):
        if credentials is None:
            credentials = ydb.credentials_from_env_variables()
        driver = ydb.Driver(endpoint=endpoint, database=database, credentials=credentials)
        try:
            driver.wait(timeout=5, fail_fast=True)
            return cls(driver, database)
        except BaseException:
            driver.stop(timeout=2)
            raise

    def close(self):
        self._pool.stop(timeout=2)
        self._driver.stop(timeout=2)

    def run_read(self, fn: Callable[[Transaction], T]) -> T:
        return self._run(fn, ydb.QuerySnapshotReadOnly(), idempotent=True)

    def run_write(self, fn: Callable[[Transaction], T]) -> T:
        return self._run(fn, ydb.QuerySerializableReadWrite(), idempotent=False)

    def _run(self, fn, mode, *, idempotent):
        settings = ydb.BaseRequestSettings().with_timeout(3)

        def operation(session):
            with session.transaction(mode) as raw_tx:
                try:
                    value = fn(_YdbTransaction(raw_tx, settings))
                except BaseException:
                    try:
                        raw_tx.rollback(settings=settings)
                    except ydb.Error:
                        # A failed YDB query can already have closed the transaction.
                        pass
                    raise
                raw_tx.commit(settings=settings)
                return value

        retry = ydb.RetrySettings(
            max_retries=4, max_session_acquire_timeout=3,
            backoff_ceiling=3, backoff_slot_duration=0.05, idempotent=idempotent,
        )
        retry.retry_not_found = False
        retry.retry_internal_error = idempotent
        try:
            return self._pool.retry_operation_sync(operation, retry_settings=retry)
        except (ydb.Error, TimeoutError) as exc:
            raise StoreUnavailable("YDB transaction failed") from exc


class _YdbTransaction:
    def __init__(self, raw_tx, settings):
        self._tx = raw_tx
        self._settings = settings

    def _rows(self, query, **values):
        parameters = {
            "$" + name: ydb.TypedValue(value, ydb.PrimitiveType.Uint64) if type(value) is int else value
            for name, value in values.items()
        }
        with self._tx.execute(query, parameters, settings=self._settings) as results:
            return [dict(row) for result in results for row in result.rows]

    def _one(self, model, query, **params):
        rows = self._rows(query, **params)
        return model(**rows[0]) if rows else None

    def backup_page(self, table, after, limit):
        model, keys = BACKUP_TABLES[table]
        order = ", ".join(keys)
        declarations = " ".join(f"DECLARE $key{i} AS Utf8;" for i in range(len(keys)))
        condition = f"{keys[0]} > $key0"
        if len(keys) == 2:
            condition += f" OR ({keys[0]} = $key0 AND {keys[1]} > $key1)"
        rows = self._rows(f"""
            {declarations}
            DECLARE $limit AS Uint64;
            SELECT * FROM `{table}` WHERE {condition} ORDER BY {order} LIMIT $limit;
        """, limit=limit, **{f"key{i}": value for i, value in enumerate(after)})
        if model is Worklog:
            for row in rows:
                row["data"] = json.loads(row.pop("data_json"))
        return [model(**row) for row in rows]

    def backup_target_empty(self):
        tables = (*BACKUP_TABLES, *_RESTORE_ONLY_TABLES)
        return not self._rows("\n".join(f"SELECT 1 AS present FROM `{table}` LIMIT 1;" for table in tables))

    def insert_backup_page(self, table, records):
        model, _ = BACKUP_TABLES[table]
        types = {str: ("Utf8", ydb.PrimitiveType.Utf8),
                 int: ("Uint64", ydb.PrimitiveType.Uint64),
                 bool: ("Bool", ydb.PrimitiveType.Bool)}
        rows = [asdict(record) for record in records]
        columns = {field.name: field.type for field in fields(model)}
        if model is Worklog:
            del columns["data"]
            columns["data_json"] = str
            for row in rows:
                row["data_json"] = json.dumps(row.pop("data"), ensure_ascii=False, allow_nan=False)
        if model is Account:
            self._insert_backup_rows("account_emails", {"email_digest": str, "uid": str},
                                     [{"email_digest": digest(row["email"]), "uid": row["uid"]} for row in rows], types)
        self._insert_backup_rows(table, columns, rows, types)

    def _insert_backup_rows(self, table, columns, rows, types):
        row_type = ydb.StructType()
        for name, kind in columns.items():
            row_type.add_member(name, types[kind][1])
        definition = ", ".join(f"{name}:{types[kind][0]}" for name, kind in columns.items())
        names = ", ".join(f"`{name}`" for name in columns)
        self._rows(f"""
            DECLARE $rows AS List<Struct<{definition}>>;
            INSERT INTO `{table}` ({names}) SELECT {names} FROM AS_TABLE($rows);
        """, rows=ydb.TypedValue(rows, ydb.ListType(row_type)))

    def get_account(self, uid):
        return self._one(Account, """
            DECLARE $uid AS Utf8;
            SELECT * FROM accounts WHERE uid = $uid;
        """, uid=uid)

    def get_account_by_email(self, email):
        return self._one(Account, """
            DECLARE $email_digest AS Utf8;
            SELECT accounts.* FROM account_emails AS lookup
            INNER JOIN accounts AS accounts ON lookup.uid = accounts.uid
            WHERE lookup.email_digest = $email_digest;
        """, email_digest=digest(email))

    def list_accounts(self, after_uid, limit):
        rows = self._rows("""
            DECLARE $after_uid AS Utf8;
            DECLARE $limit AS Uint64;
            SELECT * FROM accounts WHERE uid > $after_uid ORDER BY uid LIMIT $limit;
        """, after_uid=after_uid, limit=limit)
        return [Account(**row) for row in rows]

    def insert_account(self, account):
        try:
            self._rows("""
                DECLARE $email_digest AS Utf8;
                DECLARE $uid AS Utf8;
                INSERT INTO account_emails (email_digest, uid) VALUES ($email_digest, $uid);
            """, email_digest=digest(account.email), uid=account.uid)
        except ydb.PreconditionFailed as exc:
            raise DuplicateAccountEmail from exc
        self._rows("""
            DECLARE $uid AS Utf8;
            DECLARE $email AS Utf8;
            DECLARE $password_hash AS Utf8;
            DECLARE $role AS Utf8;
            DECLARE $enabled AS Bool;
            DECLARE $created_at AS Uint64;
            DECLARE $session_generation AS Uint64;
            INSERT INTO accounts (uid, email, password_hash, role, enabled, created_at, session_generation)
            VALUES ($uid, $email, $password_hash, $role, $enabled, $created_at, $session_generation);
        """, **asdict(account))

    def update_account_security(self, account):
        self._rows("""
            DECLARE $uid AS Utf8;
            DECLARE $password_hash AS Utf8;
            DECLARE $session_generation AS Uint64;
            UPDATE accounts SET password_hash = $password_hash, session_generation = $session_generation
            WHERE uid = $uid;
        """, uid=account.uid, password_hash=account.password_hash, session_generation=account.session_generation)

    def promote_account(self, uid, session_generation):
        self._rows("""
            DECLARE $uid AS Utf8;
            DECLARE $session_generation AS Uint64;
            DECLARE $role AS Utf8;
            UPDATE accounts SET role = $role, session_generation = $session_generation WHERE uid = $uid;
        """, uid=uid, session_generation=session_generation, role="admin")

    def get_invitation(self, digest):
        return self._one(Invitation, """
            DECLARE $digest AS Utf8;
            SELECT * FROM invitations WHERE digest = $digest;
        """, digest=digest)

    def get_invitation_by_id(self, invitation_id):
        return self._one(Invitation, """
            DECLARE $id AS Utf8;
            SELECT * FROM invitations VIEW by_id WHERE id = $id;
        """, id=invitation_id)

    def list_invitations(self):
        return [Invitation(**row) for row in self._rows(
            "SELECT * FROM invitations ORDER BY created_at DESC, id;"
        )]

    def insert_invitation(self, invitation):
        self._rows("""
            DECLARE $digest AS Utf8;
            DECLARE $id AS Utf8;
            DECLARE $issuer_uid AS Utf8;
            DECLARE $created_at AS Uint64;
            DECLARE $expires_at AS Uint64;
            DECLARE $state AS Utf8;
            DECLARE $consumed_by AS Utf8;
            INSERT INTO invitations (digest, id, issuer_uid, created_at, expires_at, state, consumed_by)
            VALUES ($digest, $id, $issuer_uid, $created_at, $expires_at, $state, $consumed_by);
        """, **asdict(invitation))

    def update_invitation(self, invitation):
        self._rows("""
            DECLARE $digest AS Utf8;
            DECLARE $state AS Utf8;
            DECLARE $consumed_by AS Utf8;
            UPDATE invitations SET state = $state, consumed_by = $consumed_by WHERE digest = $digest;
        """, digest=invitation.digest, state=invitation.state, consumed_by=invitation.consumed_by)

    def get_session_by_access(self, digest):
        return self._one(Session, """
            DECLARE $digest AS Utf8;
            SELECT sessions.* FROM session_access AS lookup
            INNER JOIN sessions AS sessions ON lookup.session_id = sessions.id
            WHERE lookup.digest = $digest;
        """, digest=digest)

    def get_session_by_refresh(self, digest):
        return self._one(Session, """
            DECLARE $digest AS Utf8;
            SELECT sessions.* FROM session_refresh AS lookup
            INNER JOIN sessions AS sessions ON lookup.session_id = sessions.id
            WHERE lookup.digest = $digest;
        """, digest=digest)

    def _index_session(self, current):
        self._rows("""
            DECLARE $id AS Utf8;
            DECLARE $access_digest AS Utf8;
            DECLARE $refresh_digest AS Utf8;
            DECLARE $expires_at AS Uint64;
            INSERT INTO session_access (digest, session_id, expires_at) VALUES ($access_digest, $id, $expires_at);
            INSERT INTO session_refresh (digest, session_id, expires_at) VALUES ($refresh_digest, $id, $expires_at);
        """, id=current.id, access_digest=current.access_digest, refresh_digest=current.refresh_digest,
            expires_at=current.refresh_expires_at)

    def insert_session(self, session):
        self._rows("""
            DECLARE $id AS Utf8;
            DECLARE $uid AS Utf8;
            DECLARE $generation AS Uint64;
            DECLARE $access_digest AS Utf8;
            DECLARE $refresh_digest AS Utf8;
            DECLARE $access_expires_at AS Uint64;
            DECLARE $refresh_expires_at AS Uint64;
            INSERT INTO sessions (id, uid, generation, access_digest, refresh_digest,
                                  access_expires_at, refresh_expires_at)
            VALUES ($id, $uid, $generation, $access_digest, $refresh_digest, $access_expires_at, $refresh_expires_at);
        """, **asdict(session))
        self._index_session(session)

    def rotate_session(self, previous, current):
        self._rows("""
            DECLARE $id AS Utf8;
            DECLARE $previous_refresh_digest AS Utf8;
            DECLARE $access_digest AS Utf8;
            DECLARE $refresh_digest AS Utf8;
            DECLARE $access_expires_at AS Uint64;
            DELETE FROM session_refresh WHERE digest = $previous_refresh_digest;
            UPDATE sessions SET access_digest = $access_digest, refresh_digest = $refresh_digest,
                                access_expires_at = $access_expires_at WHERE id = $id;
        """, id=current.id, previous_refresh_digest=previous.refresh_digest, access_digest=current.access_digest,
            refresh_digest=current.refresh_digest, access_expires_at=current.access_expires_at)
        self._index_session(current)

    def delete_session(self, session):
        self._rows("""
            DECLARE $id AS Utf8;
            DECLARE $refresh_digest AS Utf8;
            DELETE FROM sessions WHERE id = $id;
            DELETE FROM session_refresh WHERE digest = $refresh_digest;
        """, id=session.id, refresh_digest=session.refresh_digest)

    def get_reset(self, digest):
        return self._one(Reset, """
            DECLARE $digest AS Utf8;
            SELECT * FROM reset_tokens WHERE digest = $digest;
        """, digest=digest)

    def insert_reset(self, reset):
        self._rows("""
            DECLARE $digest AS Utf8;
            DECLARE $uid AS Utf8;
            DECLARE $issuer_uid AS Utf8;
            DECLARE $generation AS Uint64;
            DECLARE $expires_at AS Uint64;
            DECLARE $used AS Bool;
            INSERT INTO reset_tokens (digest, uid, issuer_uid, generation, expires_at, used)
            VALUES ($digest, $uid, $issuer_uid, $generation, $expires_at, $used);
        """, **asdict(reset))

    def mark_reset_used(self, digest):
        self._rows("""
            DECLARE $digest AS Utf8;
            UPDATE reset_tokens SET used = true WHERE digest = $digest;
        """, digest=digest)

    def get_rate_bin(self, key):
        rows = self._rows("""
            DECLARE $rate_key AS Utf8;
            SELECT rate_key, attempts_json, expires_at FROM rate_bins WHERE rate_key = $rate_key;
        """, rate_key=key)
        if not rows:
            return None
        row = rows[0]
        return RateBin(row["rate_key"], tuple(json.loads(row["attempts_json"])), row["expires_at"])

    def put_rate_bin(self, rate_bin):
        self._rows("""
            DECLARE $rate_key AS Utf8;
            DECLARE $attempts_json AS Utf8;
            DECLARE $expires_at AS Uint64;
            UPSERT INTO rate_bins (rate_key, attempts_json, expires_at) VALUES ($rate_key, $attempts_json, $expires_at);
        """, rate_key=rate_bin.rate_key, attempts_json=json.dumps(rate_bin.attempts), expires_at=rate_bin.expires_at)

    def get_worklog(self, uid):
        rows = self._rows("""
            DECLARE $uid AS Utf8;
            SELECT * FROM worklogs WHERE uid = $uid;
        """, uid=uid)
        if not rows:
            return None
        row = rows[0]
        return Worklog(row["uid"], json.loads(row["data_json"]), row["revision"], row["updated_at"])

    def put_worklog(self, worklog):
        self._rows("""
            DECLARE $uid AS Utf8;
            DECLARE $data_json AS Utf8;
            DECLARE $revision AS Uint64;
            DECLARE $updated_at AS Uint64;
            UPSERT INTO worklogs (uid, data_json, revision, updated_at)
            VALUES ($uid, $data_json, $revision, $updated_at);
        """, uid=worklog.uid, data_json=json.dumps(worklog.data, ensure_ascii=False, allow_nan=False),
            revision=worklog.revision, updated_at=worklog.updated_at)

    def get_mutation(self, uid, mutation_id):
        return self._one(Mutation, """
            DECLARE $uid AS Utf8;
            DECLARE $mutation_id AS Utf8;
            SELECT * FROM mutations WHERE uid = $uid AND mutation_id = $mutation_id;
        """, uid=uid, mutation_id=mutation_id)

    def put_mutation(self, mutation):
        self._rows("""
            DECLARE $uid AS Utf8;
            DECLARE $mutation_id AS Utf8;
            DECLARE $request_digest AS Utf8;
            DECLARE $revision AS Uint64;
            DECLARE $updated_at AS Uint64;
            UPSERT INTO mutations (uid, mutation_id, request_digest, revision, updated_at)
            VALUES ($uid, $mutation_id, $request_digest, $revision, $updated_at);
        """, **asdict(mutation))

    def put_audit(self, audit):
        self._rows("""
            DECLARE $id AS Utf8;
            DECLARE $action AS Utf8;
            DECLARE $actor_uid AS Utf8;
            DECLARE $target_id AS Utf8;
            DECLARE $created_at AS Uint64;
            INSERT INTO audit_events (id, action, actor_uid, target_id, created_at)
            VALUES ($id, $action, $actor_uid, $target_id, $created_at);
        """, **asdict(audit))
