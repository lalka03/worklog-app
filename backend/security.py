"""Password validation and opaque credentials for the Worklog authentication service."""

import hashlib
import re
import secrets

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerifyMismatchError


_HASHER = PasswordHasher(type=Type.ID)
# Hash of a public fixture, using the same work factors as real password hashes.
DUMMY_PASSWORD_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$mMuvLgiTG32GP4a/k3t5Bg"
    "$2u37Go+6eoU+kb8fnq/zUhU6EOjbFsvwMAU1YwPp9/w"
)
_EMAIL = re.compile(
    r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
    r"@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+",
    re.ASCII,
)
_TOKEN = re.compile(r"[A-Za-z0-9_-]{22,128}", re.ASCII)


def normalize_email(email):
    if not isinstance(email, str):
        return None
    normalized = email.strip().lower()
    if len(normalized) > 254 or not _EMAIL.fullmatch(normalized):
        return None
    if len(normalized.split("@", 1)[0]) > 64:
        return None
    return normalized


def valid_password(password):
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        return False
    try:
        password.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def hash_password(password):
    return _HASHER.hash(password)


def verify_password(encoded, password):
    try:
        return _HASHER.verify(encoded, password)
    except (InvalidHashError, VerifyMismatchError):
        return False


def new_token():
    return secrets.token_urlsafe(32)


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def credential_digest(token):
    if isinstance(token, str) and _TOKEN.fullmatch(token):
        return digest(token)
    return None
