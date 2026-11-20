"""In-memory implementation of the transaction contract for service tests."""

from copy import deepcopy
from dataclasses import replace
from threading import Lock
from uuid import uuid4

from backend.security import digest, new_token
from backend.store import BACKUP_TABLES, DuplicateAccountEmail, Session


def seed_test_session(store, account, now, access_token=None):
    access_token = access_token or new_token()
    store.run_write(lambda tx: tx.insert_session(Session(
        str(uuid4()), account.uid, account.session_generation, digest(access_token), digest(new_token()),
        now + 15 * 60, now + 7 * 24 * 60 * 60,
    )))
    return access_token


class FakeStore:
    database = None

    def __init__(self):
        self._lock = Lock()
        self.records = {
            name: {} for name in (
                "accounts", "account_emails", "invitations", "sessions", "session_access",
                "session_refresh", "reset_tokens", "rate_bins", "worklogs", "mutations", "audit_events",
            )
        }

    def run_read(self, fn):
        with self._lock:
            return fn(FakeTransaction(deepcopy(self.records)))

    def run_write(self, fn):
        with self._lock:
            draft = deepcopy(self.records)
            result = fn(FakeTransaction(draft))
            self.records = draft
            return result


class FakeTransaction:
    def __init__(self, records):
        self._records = records

    def _insert(self, table, key, value):
        if key in self._records[table]:
            raise ValueError("duplicate storage key")
        self._records[table][key] = value

    def backup_page(self, table, after, limit):
        _, keys = BACKUP_TABLES[table]
        indexed = {tuple(getattr(record, key) for key in keys): record for record in self._records[table].values()}
        return [indexed[key] for key in sorted(indexed) if key > after][:limit]

    def backup_target_empty(self):
        return not any(self._records.values())

    def insert_backup_page(self, table, records):
        write = {
            "accounts": self.insert_account,
            "invitations": self.insert_invitation,
            "worklogs": self.put_worklog,
            "mutations": self.put_mutation,
            "audit_events": self.put_audit,
        }[table]
        for record in records:
            write(record)

    def get_account(self, uid):
        return self._records["accounts"].get(uid)

    def get_account_by_email(self, email):
        return self.get_account(self._records["account_emails"].get(digest(email)))

    def list_accounts(self, after_uid, limit):
        accounts = self._records["accounts"]
        return [accounts[uid] for uid in sorted(accounts) if uid > after_uid][:limit]

    def insert_account(self, account):
        key = digest(account.email)
        if key in self._records["account_emails"]:
            raise DuplicateAccountEmail
        self._insert("account_emails", key, account.uid)
        self._insert("accounts", account.uid, account)

    def update_account_security(self, account):
        previous = self._records["accounts"][account.uid]
        self._records["accounts"][account.uid] = replace(
            previous, password_hash=account.password_hash, session_generation=account.session_generation,
        )

    def promote_account(self, uid, session_generation):
        account = self._records["accounts"][uid]
        self._records["accounts"][uid] = replace(account, role="admin", session_generation=session_generation)

    def get_invitation(self, digest):
        return self._records["invitations"].get(digest)

    def get_invitation_by_id(self, invitation_id):
        return next((row for row in self._records["invitations"].values() if row.id == invitation_id), None)

    def list_invitations(self):
        return sorted(self._records["invitations"].values(), key=lambda row: (-row.created_at, row.id))

    def insert_invitation(self, invitation):
        self._insert("invitations", invitation.digest, invitation)

    def update_invitation(self, invitation):
        previous = self._records["invitations"][invitation.digest]
        self._records["invitations"][invitation.digest] = replace(
            previous, state=invitation.state, consumed_by=invitation.consumed_by,
        )

    def get_session_by_access(self, digest):
        return self._records["sessions"].get(self._records["session_access"].get(digest))

    def get_session_by_refresh(self, digest):
        return self._records["sessions"].get(self._records["session_refresh"].get(digest))

    def _index_session(self, session):
        self._insert("session_access", session.access_digest, session.id)
        self._insert("session_refresh", session.refresh_digest, session.id)

    def insert_session(self, session):
        self._insert("sessions", session.id, session)
        self._index_session(session)

    def rotate_session(self, previous, current):
        del self._records["session_refresh"][previous.refresh_digest]
        self._records["sessions"][current.id] = current
        self._index_session(current)

    def delete_session(self, session):
        del self._records["sessions"][session.id]
        del self._records["session_refresh"][session.refresh_digest]

    def get_reset(self, digest):
        return self._records["reset_tokens"].get(digest)

    def insert_reset(self, reset):
        self._insert("reset_tokens", reset.digest, reset)

    def mark_reset_used(self, digest):
        self._records["reset_tokens"][digest] = replace(self._records["reset_tokens"][digest], used=True)

    def get_rate_bin(self, key):
        return self._records["rate_bins"].get(key)

    def put_rate_bin(self, rate_bin):
        self._records["rate_bins"][rate_bin.rate_key] = rate_bin

    def get_worklog(self, uid):
        return self._records["worklogs"].get(uid)

    def put_worklog(self, worklog):
        self._records["worklogs"][worklog.uid] = deepcopy(worklog)

    def get_mutation(self, uid, mutation_id):
        return self._records["mutations"].get((uid, mutation_id))

    def put_mutation(self, mutation):
        self._records["mutations"][(mutation.uid, mutation.mutation_id)] = mutation

    def put_audit(self, audit):
        self._insert("audit_events", audit.id, audit)
