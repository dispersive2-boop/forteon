"""Auth: сессии на нескольких устройствах, refresh, отзыв сессий.

Плюс защита от перебора паролей: скользящее окно по IP+логину,
карантин после серии неудач, ответ 429 с Retry-After.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, find_session, get_current_user, session_expiry
from ..models import Session as SessionModel, User, utcnow
from ..services.ratelimit import limiter
from ..schemas import (
    LoginRequest,
    PasswordChange,
    RefreshRequest,
    SessionOut,
    TokenResponse,
    UserOut,
)
from ..security import (
    create_token,
    hash_password,
    new_refresh_token,
    needs_rehash,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("forteon.auth")


def _too_many_attempts(wait: float, scope: str) -> HTTPException:
    """429 с человеческим текстом и заголовком Retry-After."""
    minutes = max(1, int(round(wait / 60)))
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={
            "code": "rate_limited",
            "message": (
                f"Слишком много попыток входа. Повторите через {minutes} мин."
                if scope == "login"
                else "Слишком много запросов. Повторите позже."
            ),
            "details": {"retry_after": int(wait)},
        },
        headers={"Retry-After": str(int(wait))},
    )


def issue_tokens(db: Session, user: User, request: Request, device_label: str | None = None) -> TokenResponse:
    access = create_token(
        {"sub": user.id, "role": user.role, "email": user.email},
        settings.secret_key,
        settings.access_token_ttl_minutes * 60,
        typ="access",
    )
    raw_refresh, digest = new_refresh_token()
    db.add(
        SessionModel(
            user_id=user.id,
            refresh_token_hash=digest,
            expires_at=session_expiry(),
            device_label=device_label or "Веб-клиент",
            user_agent=(request.headers.get("user-agent") or "")[:250],
        )
    )
    db.commit()
    return TokenResponse(
        access_token=access,
        refresh_token=raw_refresh,
        expires_in=settings.access_token_ttl_minutes * 60,
        user=UserOut.model_validate(user),
    )


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, response: Response, db: Session = Depends(get_db)):
    email = payload.email.strip().lower()
    ip = request.client.host if request.client else "unknown"

    # Ключ включает IP и логин: перебор одного аккаунта не блокирует других,
    # но и смена логина с того же IP не помогает (отдельный ключ на IP).
    key_pair = f"login:{ip}:{email}"
    key_ip = f"login-ip:{ip}"

    wait = limiter.retry_after(key_pair) or limiter.retry_after(key_ip)
    if wait:
        raise _too_many_attempts(wait, "login")

    user = db.scalar(select(User).where(User.email == email))
    if user is None or not user.is_active or user.deleted_at is not None:
        # Неудача тоже расходует лимит — иначе перебор существующих логинов
        # ничем не ограничен.
        blocked = limiter.hit(
            key_pair, settings.login_max_attempts, settings.login_window_seconds,
            max_failures=settings.login_max_attempts, lockout=settings.login_lockout_seconds,
            failed=True,
        )
        limiter.hit(
            key_ip, settings.login_max_attempts * 4, settings.login_window_seconds,
            max_failures=settings.login_max_attempts * 4, lockout=settings.login_lockout_seconds,
            failed=True,
        )
        if blocked:
            raise _too_many_attempts(blocked, "login")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Неверный e-mail или пароль"},
        )

    if not verify_password(payload.password, user.password_hash):
        blocked = limiter.hit(
            key_pair, settings.login_max_attempts, settings.login_window_seconds,
            max_failures=settings.login_max_attempts, lockout=settings.login_lockout_seconds,
            failed=True,
        )
        limiter.hit(
            key_ip, settings.login_max_attempts * 4, settings.login_window_seconds,
            max_failures=settings.login_max_attempts * 4, lockout=settings.login_lockout_seconds,
            failed=True,
        )
        audit(db, user, "user", user.id, "login_failed", ip=ip)
        db.commit()
        if blocked:
            log.warning("ForteOn: серия неудачных входов %s, карантин %.0f c", key_pair, blocked)
            raise _too_many_attempts(blocked, "login")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Неверный e-mail или пароль"},
        )

    # Успех: снимаем накопленные неудачи по этой паре IP+логин.
    limiter.reset(key_pair)

    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password)

    result = issue_tokens(db, user, request, payload.email)
    result_user = UserOut.model_validate(user)
    audit(db, user, "user", user.id, "login", ip=ip)
    db.commit()

    response.set_cookie(
        settings.cookie_name,
        result.access_token,
        max_age=settings.access_token_ttl_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return TokenResponse(
        access_token=result.access_token,
        refresh_token=result.refresh_token,
        expires_in=result.expires_in,
        user=result_user,
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, request: Request, db: Session = Depends(get_db)):
    key = limiter.client_key(request, "refresh")
    wait = limiter.hit(key, 60, 60)
    if wait:
        raise _too_many_attempts(wait, "refresh")

    raw = payload.refresh_token or request.cookies.get("forteon_refresh")
    if not raw:
        raise HTTPException(status_code=401, detail={"code": "missing_token", "message": "Нет refresh-токена"})
    session = find_session(db, raw)
    if session is None or session.revoked_at is not None or session.expires_at < utcnow():
        raise HTTPException(status_code=401, detail={"code": "invalid_token", "message": "Сессия недействительна"})
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail={"code": "inactive_user", "message": "Пользователь отключён"})
    return issue_tokens(db, user, request, session.device_label)


@router.post("/logout")
def logout(request: Request, payload: RefreshRequest | None = None, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    raw = (payload.refresh_token if payload else None) or request.cookies.get("forteon_refresh")
    if raw:
        session = find_session(db, raw)
        if session and session.user_id == user.id:
            session.revoked_at = utcnow()
    audit(db, user, "user", user.id, "logout")
    db.commit()
    return {"status": "ok"}


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.model_validate(user)


@router.post("/password")
def change_password(payload: PasswordChange, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail={"code": "bad_password", "message": "Неверный текущий пароль"})
    user.password_hash = hash_password(payload.new_password)
    user.version = (user.version or 1) + 1
    audit(db, user, "user", user.id, "password_changed")
    db.commit()
    return {"status": "ok"}


@router.get("/sessions", response_model=list[SessionOut])
def list_sessions(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    sessions = db.scalars(
        select(SessionModel).where(SessionModel.user_id == user.id).order_by(SessionModel.created_at.desc())
    )
    return [SessionOut.model_validate(s) for s in sessions]


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    session = db.get(SessionModel, session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Сессия не найдена"})
    session.revoked_at = utcnow()
    audit(db, user, "session", session_id, "revoked")
    db.commit()
    return {"status": "ok"}
