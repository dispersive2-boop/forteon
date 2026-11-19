"""Зависимости: текущий пользователь, проверка владения клиентом, аудит."""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuditLog, Client, Session as SessionModel, User, utcnow
from .security import decode_token, hash_refresh_token


def _extract_token(request: Request, authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    cookie = request.cookies.get(settings.cookie_name)
    return cookie or None


def get_optional_user(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> User | None:
    token = _extract_token(request, authorization)
    if not token:
        return None
    payload = decode_token(token, settings.secret_key, expected_typ="access")
    if not payload:
        return None
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active or user.deleted_at is not None:
        return None
    return user


def get_current_user(user: User | None = Depends(get_optional_user)) -> User:
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Требуется авторизация"},
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Требуются права администратора"},
        )
    return user


def get_client_or_404(db: Session, user: User, client_id: str) -> Client:
    """Менеджер видит только своих клиентов; админ — всех."""
    client = db.get(Client, client_id)
    if not client or client.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Клиент не найден"})
    if user.role != "admin" and client.owner_id != user.id:
        # Специально 404, а не 403: не раскрываем существование чужого клиента.
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Клиент не найден"})
    return client


def ensure_version(obj, version: int | None) -> None:
    if version is not None and getattr(obj, "version", None) != version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "version_conflict",
                "message": "Запись изменена другим устройством",
                "details": {"current_version": getattr(obj, "version", None)},
            },
        )


def audit(db: Session, user: User | None, entity: str, entity_id: str | None, action: str,
          metadata: dict | None = None, ip: str | None = None) -> None:
    db.add(
        AuditLog(
            actor_id=user.id if user else None,
            entity=entity,
            entity_id=entity_id,
            action=action,
            metadata_json=json.dumps(metadata, ensure_ascii=False) if metadata else None,
            ip=ip,
        )
    )


def bump_version(obj) -> None:
    obj.version = (obj.version or 1) + 1
    obj.updated_at = utcnow()


def session_expiry(days: int | None = None) -> datetime:
    return utcnow() + timedelta(days=days or settings.refresh_token_ttl_days)


def find_session(db: Session, raw_refresh: str) -> SessionModel | None:
    digest = hash_refresh_token(raw_refresh)
    return db.scalar(select(SessionModel).where(SessionModel.refresh_token_hash == digest))
