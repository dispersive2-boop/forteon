"""Безопасность: хеширование паролей и токены сессий.

Argon2id — если установлен argon2-cffi, иначе scrypt из стандартной библиотеки
(для локальной разработки без зависимостей).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

try:  # предпочтительный вариант — Argon2id
    from argon2 import PasswordHasher
    from argon2.exceptions import VerifyMismatchError

    _hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)
    _ARGON = True
except Exception:  # pragma: no cover - fallback среды разработки
    _hasher = None
    _ARGON = False
    VerifyMismatchError = Exception  # type: ignore[assignment,misc]


def hash_password(password: str) -> str:
    if _ARGON:
        return _hasher.hash(password)
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()


def verify_password(password: str, stored: str) -> bool:
    if stored.startswith("scrypt$"):
        try:
            _, salt_b64, digest_b64 = stored.split("$")
            salt = base64.b64decode(salt_b64)
            expected = base64.b64decode(digest_b64)
            actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
            return hmac.compare_digest(expected, actual)
        except Exception:
            return False
    if _ARGON:
        try:
            return _hasher.verify(stored, password)
        except VerifyMismatchError:
            return False
        except Exception:
            return False
    return False


def needs_rehash(stored: str) -> bool:
    return not stored.startswith("scrypt$") and not _ARGON


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _unb64url(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(raw + padding)


def create_token(payload: dict[str, Any], secret: str, ttl_seconds: int, typ: str = "access") -> str:
    """Компактный подписанный токен (HS256-совместимая схема без внешних зависимостей)."""
    header = {"alg": "HS256", "typ": "JWT"}
    body = dict(payload)
    body["iat"] = int(time.time())
    body["exp"] = int(time.time()) + ttl_seconds
    body["typ"] = typ
    body["jti"] = secrets.token_hex(12)
    segments = [
        _b64url(json.dumps(header, separators=(",", ":")).encode()),
        _b64url(json.dumps(body, separators=(",", ":"), default=str).encode()),
    ]
    signing_input = ".".join(segments).encode()
    signature = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    segments.append(_b64url(signature))
    return ".".join(segments)


def decode_token(token: str, secret: str, expected_typ: str | None = None) -> dict[str, Any] | None:
    try:
        header_b64, body_b64, sig_b64 = token.split(".")
    except ValueError:
        return None
    signing_input = f"{header_b64}.{body_b64}".encode()
    expected = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    try:
        provided = _unb64url(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected, provided):
        return None
    try:
        body = json.loads(_unb64url(body_b64))
    except Exception:
        return None
    if int(body.get("exp", 0)) < int(time.time()):
        return None
    if expected_typ and body.get("typ") != expected_typ:
        return None
    return body


def new_refresh_token() -> tuple[str, str]:
    """Возвращает (raw_token, sha256_hash) — в БД хранится только хеш."""
    raw = secrets.token_urlsafe(48)
    return raw, hashlib.sha256(raw.encode()).hexdigest()


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
