"""Администрирование: пользователи, передачи клиентов, аудит, настройки AI, импорт."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, get_client_or_404, get_current_user, require_admin
from ..models import AuditLog, Client, ClientTransfer, Task, User, utcnow
from ..schemas import (
    AISettingsIn,
    ImportResult,
    TransferRequest,
    UserCreate,
    UserOut,
    UserUpdate,
)
from ..security import hash_password
from ..services.importer import import_xlsx

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    rows = db.scalars(select(User).where(User.deleted_at.is_(None)).order_by(User.full_name))
    return [UserOut.model_validate(u) for u in rows]


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(payload: UserCreate, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    email = payload.email.strip().lower()
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=409, detail={"code": "duplicate", "message": "Пользователь уже существует"})
    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name.strip(),
        role=payload.role,
        timezone=payload.timezone or settings.default_timezone,
    )
    db.add(user)
    db.flush()
    audit(db, admin, "user", user.id, "created", {"email": email, "role": payload.role})
    db.commit()
    db.refresh(user)
    return UserOut.model_validate(user)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: str, payload: UserUpdate, db: Session = Depends(get_db),
                admin: User = Depends(require_admin)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Пользователь не найден"})
    data = payload.model_dump(exclude_unset=True)
    if "password" in data and data["password"]:
        user.password_hash = hash_password(data.pop("password"))
    for key, value in data.items():
        if value is not None:
            setattr(user, key, value)
    user.version = (user.version or 1) + 1
    audit(db, admin, "user", user.id, "updated", {"fields": list(data)})
    db.commit()
    db.refresh(user)
    return UserOut.model_validate(user)


@router.post("/clients/{client_id}/transfer")
def transfer_client(client_id: str, payload: TransferRequest, db: Session = Depends(get_db),
                    admin: User = Depends(require_admin)):
    client = get_client_or_404(db, admin, client_id)
    target = db.get(User, payload.to_user_id)
    if target is None or not target.is_active:
        raise HTTPException(status_code=400, detail={"code": "bad_user", "message": "Получатель недоступен"})
    if target.id == client.owner_id:
        raise HTTPException(status_code=400, detail={"code": "same_owner", "message": "Клиент уже у этого менеджера"})

    previous = client.owner_id
    client.owner_id = target.id
    client.version = (client.version or 1) + 1
    db.add(
        ClientTransfer(
            client_id=client.id,
            from_user_id=previous,
            to_user_id=target.id,
            transferred_by=admin.id,
            comment=payload.comment,
        )
    )
    # Задачи переходят новому владельцу
    db.query(Task).filter(Task.client_id == client.id, Task.status == "open").update(
        {"assignee_id": target.id}, synchronize_session=False
    )
    audit(db, admin, "client", client.id, "transferred",
          {"from": previous, "to": target.id, "comment": payload.comment})
    db.commit()
    return {"status": "ok", "owner_id": target.id}


@router.get("/transfers")
def list_transfers(limit: int = Query(default=50, ge=1, le=200), db: Session = Depends(get_db),
                   _: User = Depends(require_admin)):
    rows = db.scalars(select(ClientTransfer).order_by(ClientTransfer.transferred_at.desc()).limit(limit))
    return [
        {
            "id": t.id,
            "client_id": t.client_id,
            "from_user_id": t.from_user_id,
            "to_user_id": t.to_user_id,
            "transferred_by": t.transferred_by,
            "transferred_at": t.transferred_at,
            "comment": t.comment,
        }
        for t in rows
    ]


@router.get("/audit-log")
def audit_log(limit: int = Query(default=100, ge=1, le=500), entity: str | None = None,
              db: Session = Depends(get_db), _: User = Depends(require_admin)):
    query = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    if entity:
        query = select(AuditLog).where(AuditLog.entity == entity).order_by(
            AuditLog.created_at.desc()
        ).limit(limit)
    return [
        {
            "id": a.id,
            "actor_id": a.actor_id,
            "entity": a.entity,
            "entity_id": a.entity_id,
            "action": a.action,
            "metadata": json.loads(a.metadata_json) if a.metadata_json else None,
            "ip": a.ip,
            "created_at": a.created_at,
        }
        for a in db.scalars(query)
    ]


@router.get("/ai-settings")
def get_ai_settings(_: User = Depends(require_admin)):
    return {
        "model": settings.ai_model,
        "enabled": settings.ai_enabled,
        "max_tokens": settings.ai_max_tokens,
        "provider": settings.ai_base_url,
        "key_configured": bool(settings.ai_api_key),
        "timeout_seconds": settings.ai_timeout_seconds,
        "retries": settings.ai_max_retries,
        "json_mode": settings.ai_json_mode,
        "watcher_enabled": settings.note_watcher_enabled,
        "watcher_interval": settings.note_watcher_interval,
    }


@router.get("/ai-health")
def ai_health(_: User = Depends(require_admin)):
    """Реальный запрос к провайдеру: доступен ли ключ и endpoint."""
    from ..services.ai import ping

    return ping()


@router.post("/ai-sync-notes")
def ai_sync_notes(
    limit: int = 20,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Принудительно обработать заметки в статусе pending/failed прямо сейчас."""
    from ..services.watcher import process_pending_notes

    processed = process_pending_notes(db, limit=limit)
    audit(db, admin, "notes", None, "ai_sync", {"processed": processed})
    db.commit()
    return {"processed": processed}


@router.patch("/ai-settings")
def update_ai_settings(payload: AISettingsIn, db: Session = Depends(get_db),
                       admin: User = Depends(require_admin)):
    # В MVP настройки применяются на уровне процесса; в production — таблица настроек.
    if payload.model:
        settings.ai_model = payload.model
    if payload.enabled is not None:
        settings.ai_enabled = payload.enabled
    if payload.max_tokens:
        settings.ai_max_tokens = payload.max_tokens
    audit(db, admin, "settings", None, "ai_updated", payload.model_dump(exclude_none=True))
    db.commit()
    return {"status": "ok", "applied": payload.model_dump(exclude_none=True)}


@router.post("/import/grishanov", response_model=ImportResult)
async def import_grishanov(
    file: UploadFile | None = File(default=None),
    default_path: bool = True,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """Импорт отчётной таблицы. Если файл не передан — ищет на рабочем столе."""
    source_name: str
    target: Path

    if file is not None:
        target = settings.storage_dir / f"import_{utcnow().strftime('%Y%m%d%H%M%S')}_{file.filename}"
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("wb") as output:
            while chunk := await file.read(1024 * 512):
                output.write(chunk)
        source_name = file.filename or target.name
    else:
        candidates = [
            Path("C:/Users/Gamer/Desktop/Отчетная таблица Гришанов к совещанию 16.11.2026.xlsx"),
            Path("C:/Users/Gamer/Desktop"),
        ]
        found: Path | None = None
        for candidate in candidates:
            if candidate.is_file() and candidate.suffix == ".xlsx":
                found = candidate
                break
            if candidate.is_dir():
                matches = sorted(candidate.glob("*Гришанов*.xlsx"))
                if matches:
                    found = matches[0]
                    break
        if found is None or not default_path:
            raise HTTPException(
                status_code=404,
                detail={"code": "file_not_found", "message": "Файл отчёта не найден, передайте его в запросе"},
            )
        target = found
        source_name = found.name

    try:
        stats = import_xlsx(db, target, admin)
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail={"code": "import_failed", "message": f"{type(exc).__name__}: {exc}"},
        )

    audit(db, admin, "import", None, "grishanov", {"file": source_name})
    db.commit()
    return ImportResult(
        source=source_name,
        clients_created=stats.clients_created,
        clients_reused=stats.clients_reused,
        projects_created=stats.projects_created,
        tasks_created=stats.tasks_created,
        problems_created=stats.problems_created,
        skipped_rows=stats.skipped_rows,
        warnings=stats.warnings,
    )


@router.get("/stats")
def admin_stats(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return {
        "users": db.scalar(select(func.count()).select_from(User)) or 0,
        "clients": db.scalar(select(func.count()).select_from(Client).where(Client.deleted_at.is_(None))) or 0,
        "tasks_open": db.scalar(
            select(func.count()).select_from(Task).where(Task.status == "open", Task.deleted_at.is_(None))
        ) or 0,
        "tasks_overdue": db.scalar(
            select(func.count()).select_from(Task).where(
                Task.status == "open",
                Task.due_date.is_not(None),
                Task.deleted_at.is_(None),
            )
        ) or 0,
    }
