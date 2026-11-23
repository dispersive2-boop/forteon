"""Auth: сессии на нескольких устройствах, refresh, отзыв сессий.

Плюс защита от перебора паролей: скользящее окно по IP+логину,
карантин после серии неудач, ответ 429 с Retry-After.
"""
from __future__ import annotations

import logging
from io import BytesIO

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, find_session, get_access_claims, get_current_user, session_expiry
from ..models import Session as SessionModel, User, UserAvatar, utcnow
from ..services.ratelimit import limiter
from ..schemas import (
    LoginRequest,
    PasswordChange,
    UserUpdate,
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


def _token_response(user: User, session_id: str, raw_refresh: str) -> TokenResponse:
    ttl = settings.access_token_ttl_minutes * 60
    return TokenResponse(
        access_token=create_token(
            {"sub": user.id, "role": user.role, "email": user.email, "sid": session_id},
            settings.secret_key,
            ttl,
            typ="access",
        ),
        refresh_token=raw_refresh,
        expires_in=ttl,
        user=UserOut.model_validate(user),
    )


def issue_tokens(db: Session, user: User, request: Request, device_label: str | None = None) -> TokenResponse:
    raw_refresh, digest = new_refresh_token()
    session = SessionModel(
        user_id=user.id,
        refresh_token_hash=digest,
        expires_at=session_expiry(),
        device_label=device_label or "Веб-клиент",
        user_agent=(request.headers.get("user-agent") or "")[:250],
    )
    db.add(session)
    db.commit()
    return _token_response(user, session.id, raw_refresh)


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
def refresh(payload: RefreshRequest, request: Request, response: Response, db: Session = Depends(get_db)):
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
    new_raw, digest = new_refresh_token()
    changed = db.execute(update(SessionModel).where(
        SessionModel.id == session.id,
        SessionModel.refresh_token_hash == session.refresh_token_hash,
        SessionModel.revoked_at.is_(None),
        SessionModel.expires_at > utcnow(),
    ).values(refresh_token_hash=digest, expires_at=session_expiry()))
    if changed.rowcount != 1:
        raise HTTPException(status_code=401, detail={"code": "invalid_token", "message": "Сессия недействительна"})
    db.commit()
    result = _token_response(user, session.id, new_raw)
    response.set_cookie(
        settings.cookie_name, result.access_token, max_age=result.expires_in,
        httponly=True, secure=settings.cookie_secure, samesite="lax", path="/",
    )
    return result


@router.post("/logout")
def logout(
    request: Request, response: Response, payload: RefreshRequest | None = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
    claims: dict | None = Depends(get_access_claims),
):
    raw = (payload.refresh_token if payload else None) or request.cookies.get("forteon_refresh")
    session_id = (claims or {}).get("sid")
    session = db.get(SessionModel, session_id) if session_id else (find_session(db, raw) if raw else None)
    if session and session.user_id == user.id:
        session.revoked_at = utcnow()
    audit(db, user, "user", user.id, "logout")
    db.commit()
    response.delete_cookie(settings.cookie_name, path="/")
    response.delete_cookie("forteon_refresh", path="/")
    return {"status": "ok"}


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return UserOut.model_validate(user)


@router.patch("/me/preferences", response_model=UserOut)
def update_preferences(payload: UserUpdate, db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)):
    """п.23 «30 идей»: менеджер сам выбирает время утренней сводки.

    Отдельный эндпоинт, а не правка через админку: настройка личная, и
    менеджер не должен просить администратора её поменять. Меняем только
    те поля, которые действительно его; роль и активность — нет.
    """
    data = payload.model_dump(exclude_unset=True)
    if "digest_time" in data:
        value = (data.pop("digest_time") or "").strip()
        if value:
            parts = value.split(":")
            try:
                hour, minute = int(parts[0]), int(parts[1])
            except (IndexError, ValueError):
                raise HTTPException(status_code=422, detail={
                    "code": "invalid_time", "message": "Время укажите как ЧЧ:ММ",
                }) from None
            if not (0 <= hour <= 23 and 0 <= minute <= 59):
                raise HTTPException(status_code=422, detail={
                    "code": "invalid_time", "message": "Время вне диапазона дня",
                })
            user.digest_time = f"{hour:02d}:{minute:02d}"
        else:
            # Пустая строка — «не присылать сводку». Это выбор, а не сбой.
            user.digest_time = None
    if "timezone" in data and data["timezone"]:
        user.timezone = data["timezone"]
    user.version = (user.version or 1) + 1
    audit(db, user, "user", user.id, "preferences_updated", {"fields": list(data)})
    db.commit()
    db.refresh(user)
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


def _active_sessions(db: Session, user_id: str, current_id: str | None) -> list[SessionOut]:
    rows = db.scalars(select(SessionModel).where(
        SessionModel.user_id == user_id,
        SessionModel.revoked_at.is_(None),
        SessionModel.expires_at > utcnow(),
    ).order_by(SessionModel.created_at.desc()))
    return [
        SessionOut.model_validate(row).model_copy(update={"is_current": row.id == current_id})
        for row in rows
    ]


@router.get("/sessions", response_model=list[SessionOut])
def list_sessions(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    claims: dict | None = Depends(get_access_claims),
):
    return _active_sessions(db, user.id, (claims or {}).get("sid"))


@router.post("/sessions/revoke-others", response_model=list[SessionOut])
def revoke_other_sessions(
    request: Request, payload: RefreshRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    claims: dict | None = Depends(get_access_claims),
):
    current_id = (claims or {}).get("sid")
    if not current_id:
        raw = payload.refresh_token or request.cookies.get("forteon_refresh")
        current = find_session(db, raw) if raw else None
        if current and current.user_id == user.id and not current.revoked_at and current.expires_at > utcnow():
            current_id = current.id
    if not current_id:
        raise HTTPException(status_code=409, detail={
            "code": "current_session_unknown",
            "message": "Не удалось определить текущую сессию. Войдите в аккаунт заново.",
        })
    changed = db.execute(update(SessionModel).where(
        SessionModel.user_id == user.id,
        SessionModel.id != current_id,
        SessionModel.revoked_at.is_(None),
        SessionModel.expires_at > utcnow(),
    ).values(revoked_at=utcnow()))
    audit(db, user, "session", current_id, "revoked_others", {"count": changed.rowcount})
    db.commit()
    return _active_sessions(db, user.id, current_id)


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    session = db.get(SessionModel, session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Сессия не найдена"})
    session.revoked_at = utcnow()
    audit(db, user, "session", session_id, "revoked")
    db.commit()
    return {"status": "ok"}


@router.get("/avatar")
def get_avatar(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    avatar = db.get(UserAvatar, user.id)
    headers = {"Cache-Control": "private, no-store"}
    if avatar is None:
        return Response(status_code=204, headers=headers)
    return Response(content=avatar.image, media_type="image/jpeg", headers=headers)


@router.post("/avatar", status_code=204)
def update_avatar(
    file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    limit = 5 * 1024 * 1024
    contents = file.file.read(limit + 1)
    if len(contents) > limit:
        raise HTTPException(status_code=413, detail={"message": "Фото должно быть не больше 5 МБ."})
    try:
        with Image.open(BytesIO(contents)) as original:
            if original.format not in {"JPEG", "PNG", "WEBP"} or original.width * original.height > 20_000_000:
                raise ValueError
            image = ImageOps.fit(ImageOps.exif_transpose(original).convert("RGB"), (384, 384))
            output = BytesIO()
            image.save(output, format="JPEG", quality=88, optimize=True)
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
        raise HTTPException(status_code=422, detail={"message": "Не удалось прочитать фото JPG, PNG или WebP."})
    db.merge(UserAvatar(user_id=user.id, image=output.getvalue()))
    db.commit()
    return Response(status_code=204)


@router.delete("/avatar", status_code=204)
def delete_avatar(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    avatar = db.get(UserAvatar, user.id)
    if avatar is not None:
        db.delete(avatar)
        db.commit()
    return Response(status_code=204)
