"""Auth: сессии на нескольких устройствах, refresh, отзыв сессий."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, find_session, get_current_user, session_expiry
from ..models import Session as SessionModel, User, utcnow
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
    user = db.scalar(select(User).where(User.email == payload.email.strip().lower()))
    if user is None or not user.is_active or user.deleted_at is not None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Неверный e-mail или пароль"},
        )
    if not verify_password(payload.password, user.password_hash):
        audit(db, user, "user", user.id, "login_failed", ip=request.client.host if request.client else None)
        db.commit()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "invalid_credentials", "message": "Неверный e-mail или пароль"},
        )
    if needs_rehash(user.password_hash):
        user.password_hash = hash_password(payload.password)

    result = issue_tokens(db, user, request, payload.email)
    result_user = UserOut.model_validate(user)
    audit(db, user, "user", user.id, "login", ip=request.client.host if request.client else None)
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
