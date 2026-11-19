"""Заметки, голосовые транскрипции и AI-извлечение задач."""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import SessionLocal, get_db
from ..deps import audit, get_client_or_404, get_current_user
from ..models import AIRun, Commitment, Note, Task, User, utcnow
from ..schemas import (
    AIStatusOut,
    NoteCreate,
    NoteOut,
    NoteUpdate,
    TaskOut,
    TranscriptRequest,
)
from ..services.extraction import run_extraction

router = APIRouter(tags=["notes"])


def _note_for_user(db: Session, user: User, note_id: str) -> Note:
    note = db.get(Note, note_id)
    if note is None or note.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Заметка не найдена"})
    get_client_or_404(db, user, note.client_id)
    return note


def _process_note_background(note_id: str, author_id: str) -> None:
    db = SessionLocal()
    try:
        note = db.get(Note, note_id)
        author = db.get(User, author_id)
        if note is None or author is None:
            return
        run_extraction(db, note, author)
        db.commit()
    except Exception as exc:  # заметка не должна теряться
        db.rollback()
        note = db.get(Note, note_id)
        if note is not None:
            note.ai_status = "failed"
            note.ai_error = f"{type(exc).__name__}: {exc}"
            db.commit()
    finally:
        db.close()


@router.get("/notes/feed")
def notes_feed(
    limit: int = Query(default=30, ge=1, le=200),
    before: datetime | None = None,
    client_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Общая лента заметок по всем клиентам менеджера — одна выборка вместо N запросов.

    Отдаём не только текст, но и то, во что заметка превратилась: задачи и
    обязательства. Фронтенд не делает N запросов на /notes/{id}/tasks, а сразу
    показывает менеджеру «из этой фразы родилась задача».
    """
    from ..models import Client

    query = (
        select(Note, Client.name)
        .join(Client, Client.id == Note.client_id)
        .where(Note.deleted_at.is_(None), Client.deleted_at.is_(None))
    )
    if user.role != "admin":
        query = query.where(Client.owner_id == user.id)
    if client_id:
        get_client_or_404(db, user, client_id)
        query = query.where(Note.client_id == client_id)
    # Курсор пагинации: «покажи то, что старше последней загруженной заметки»
    if before:
        query = query.where(Note.created_at < before)

    rows = db.execute(query.order_by(Note.created_at.desc()).limit(limit)).all()
    if not rows:
        return {"items": [], "total": 0, "next_before": None, "has_more": False}

    note_ids = [note.id for note, _ in rows]
    task_rows = db.execute(
        select(
            Task.source_note_id,
            Task.id,
            Task.title,
            Task.status,
            Task.due_date,
            Task.due_at,
            Task.priority,
            Task.source_quote,
            Task.type,
            Task.needs_review,
        )
        .where(Task.source_note_id.in_(note_ids), Task.deleted_at.is_(None))
        .order_by(Task.created_at.asc())
    ).all()

    tasks_by_note: dict[str, list[dict]] = {}
    for (
        source_note_id,
        task_id,
        title,
        task_status,
        due_date,
        due_at,
        priority,
        source_quote,
        task_type,
        needs_review,
    ) in task_rows:
        tasks_by_note.setdefault(source_note_id, []).append(
            {
                "id": task_id,
                "title": title,
                "status": task_status,
                "due_date": due_date.isoformat() if due_date else None,
                "due_at": due_at.isoformat() if due_at else None,
                "priority": priority,
                "type": task_type,
                "source_quote": source_quote,
                "needs_review": needs_review,
            }
        )

    commit_rows = db.execute(
        select(
            Commitment.client_id,
            Commitment.description,
            Commitment.promised_by,
            Commitment.due_date,
            Commitment.source_quote,
            Commitment.related_task_id,
        ).where(Commitment.client_id.in_({note.client_id for note, _ in rows}))
    ).all()
    task_to_note = {row_id: nid for nid, tasks in tasks_by_note.items() for row_id in [t["id"] for t in tasks]}
    commitments_by_note: dict[str, list[dict]] = {}
    for commitment in commit_rows:
        note_id = task_to_note.get(commitment.related_task_id or "")
        if not note_id:
            continue
        commitments_by_note.setdefault(note_id, []).append(
            {
                "description": commitment.description,
                "promised_by": commitment.promised_by,
                "due_date": commitment.due_date.isoformat() if commitment.due_date else None,
                "source_quote": commitment.source_quote,
            }
        )

    items = []
    for note, client_name in rows:
        payload = NoteOut.model_validate(note).model_dump()
        payload["client_name"] = client_name
        linked = tasks_by_note.get(note.id, [])
        payload["task_count"] = len(linked)
        payload["open_task_count"] = sum(1 for t in linked if t["status"] == "open")
        payload["tasks"] = linked
        payload["commitments"] = commitments_by_note.get(note.id, [])
        items.append(payload)

    oldest = rows[-1][0].created_at
    return {
        "items": items,
        "total": len(items),
        "next_before": oldest.isoformat() if len(items) == limit else None,
        "has_more": len(items) == limit,
    }


@router.get("/clients/{client_id}/notes")
def list_notes(
    client_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    before: datetime | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    История заметок по объекту.

    Кроме самой заметки отдаём, во что она превратилась: количество и
    заголовки созданных из неё задач. Раньше фронтенд делал бы N запросов
    на /notes/{id}/tasks; здесь это один групповой запрос на всю ленту.
    """
    client = get_client_or_404(db, user, client_id)
    query = select(Note).where(Note.client_id == client.id, Note.deleted_at.is_(None))
    if before:
        query = query.where(Note.created_at < before)
    notes = list(db.scalars(query.order_by(Note.created_at.desc()).limit(limit)))
    if not notes:
        return {"items": [], "total": 0}

    note_ids = [n.id for n in notes]
    task_rows = db.execute(
        select(Task.source_note_id, Task.title, Task.status)
        .where(Task.source_note_id.in_(note_ids), Task.deleted_at.is_(None))
        .order_by(Task.created_at.asc())
    ).all()

    by_note: dict[str, list[dict]] = {}
    for note_id, title, task_status in task_rows:
        by_note.setdefault(note_id, []).append({"title": title, "status": task_status})

    items = []
    for note in notes:
        payload = NoteOut.model_validate(note).model_dump()
        linked = by_note.get(note.id, [])
        payload["task_count"] = len(linked)
        payload["tasks"] = linked[:5]
        payload["open_task_count"] = sum(1 for t in linked if t["status"] == "open")
        items.append(payload)

    return {"items": items, "total": len(items)}


@router.post("/clients/{client_id}/notes", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
def create_note(
    client_id: str,
    payload: NoteCreate,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    client = get_client_or_404(db, user, client_id)

    if payload.idempotency_key:
        existing = db.scalar(
            select(Note).where(
                Note.client_id == client.id,
                Note.idempotency_key == payload.idempotency_key,
                Note.deleted_at.is_(None),
            )
        )
        if existing:
            return NoteOut.model_validate(existing)

    note = Note(
        client_id=client.id,
        project_id=payload.project_id,
        author_id=user.id,
        body=payload.body.strip(),
        source_type=payload.source_type,
        ai_status="pending" if payload.run_ai else "skipped",
        idempotency_key=payload.idempotency_key,
        note_timezone=payload.timezone or user.timezone,
    )
    db.add(note)
    db.flush()
    audit(db, user, "note", note.id, "created", {"client_id": client.id})
    db.commit()
    db.refresh(note)

    if payload.run_ai:
        background.add_task(_process_note_background, note.id, user.id)

    return NoteOut.model_validate(note)


@router.patch("/notes/{note_id}", response_model=NoteOut)
def update_note(note_id: str, payload: NoteUpdate, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    note = _note_for_user(db, user, note_id)
    if payload.version is not None and payload.version != note.version:
        raise HTTPException(status_code=409, detail={"code": "version_conflict", "message": "Заметка изменена"})
    if payload.body is not None:
        note.body = payload.body.strip()
    note.version = (note.version or 1) + 1
    # Ранее выполненные задачи не удаляются автоматически (раздел 07)
    audit(db, user, "note", note.id, "updated")
    db.commit()
    db.refresh(note)
    return NoteOut.model_validate(note)


@router.delete("/notes/{note_id}")
def delete_note(note_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    note = _note_for_user(db, user, note_id)
    note.deleted_at = utcnow()
    note.version = (note.version or 1) + 1
    audit(db, user, "note", note.id, "deleted")
    db.commit()
    return {"status": "ok"}


@router.get("/notes/{note_id}/ai-status", response_model=AIStatusOut)
def ai_status(note_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    note = _note_for_user(db, user, note_id)
    runs = list(db.scalars(select(AIRun).where(AIRun.note_id == note.id).order_by(AIRun.created_at.desc())))
    tasks = list(
        db.scalars(select(Task).where(Task.source_note_id == note.id, Task.deleted_at.is_(None)))
    )
    commitments = list(db.scalars(select(Commitment).where(Commitment.client_id == note.client_id)))

    needs_review: list[dict] = []
    if runs and runs[0].result_json:
        try:
            parsed = json.loads(runs[0].result_json)
            needs_review = parsed.get("needs_review") or []
        except json.JSONDecodeError:
            needs_review = []

    return AIStatusOut(
        note_id=note.id,
        ai_status=note.ai_status,
        ai_error=note.ai_error,
        runs=[
            {
                "id": r.id,
                "model": r.model,
                "status": r.status,
                "tokens": r.tokens,
                "cost": r.cost,
                "error": r.error,
                "created_at": r.created_at.isoformat(),
            }
            for r in runs
        ],
        tasks_created=len(tasks),
        commitments_created=len([c for c in commitments if c.source_quote]),
        needs_review=needs_review,
    )


@router.post("/notes/{note_id}/reprocess", response_model=AIStatusOut)
def reprocess(note_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    note = _note_for_user(db, user, note_id)
    result = run_extraction(db, note, user)
    audit(db, user, "note", note.id, "reprocessed", {"tasks": len(result.tasks)})
    db.commit()
    return ai_status(note_id, db, user)


@router.get("/notes/{note_id}/tasks", response_model=list[TaskOut])
def note_tasks(note_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    note = _note_for_user(db, user, note_id)
    rows = db.scalars(
        select(Task).where(Task.source_note_id == note.id, Task.deleted_at.is_(None))
        .order_by(Task.created_at)
    )
    return [TaskOut.model_validate(t) for t in rows]


@router.post("/voice/transcriptions", status_code=201)
def voice_transcription(payload: TranscriptRequest, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """MVP: транскрипция приходит от клиента/STT-сервиса, сервер сохраняет её как текст.

    В production здесь выполняется вызов STT-провайдера и сохранение аудио в приватном
    хранилище; контракт ответа сохраняется.
    """
    return {
        "status": "accepted",
        "text": payload.text,
        "client_id": payload.client_id,
        "language": "ru",
        "provider": "client-side-stt",
        "created_at": utcnow().isoformat(),
    }
