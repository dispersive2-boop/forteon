"""Заметки, голосовые транскрипции и AI-извлечение задач."""
from __future__ import annotations

import json

import httpx
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
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
from ..services.ai import provider_failure_message
from ..services.extraction import run_extraction
from ..services.summary import build_summary

router = APIRouter(tags=["notes"])


def _describe_run(model: str | None, error: str | None) -> str:
    if model == "local-rules":
        return "Заметку обработали по локальным правилам."
    if model == "local-rules-fallback":
        return f"Заметку обработали по локальным правилам. {provider_failure_message(error)}"
    if model:
        return "Заметку обработала модель."
    return "Заметка ещё не обработана."


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
    q: str | None = Query(default=None, description="Поиск по тексту заметки"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Общая лента заметок по всем клиентам менеджера — одна выборка вместо N запросов.

    Отдаём не только текст, но и то, во что заметка превратилась: задачи и
    обязательства. Фронтенд не делает N запросов на /notes/{id}/tasks, а сразу
    показывает менеджеру «из этой фразы родилась задача».

    `q` ищет по телу заметки (п.4.6 аудита) — раньше поиска по тексту не было.
    `author_name` отдаётся вместе с заметкой (п.4.2) — раньше автор был только
    в БД и в интерфейс не попадал.
    """
    from ..models import Client

    query = (
        select(Note, Client.name, User.full_name)
        .join(Client, Client.id == Note.client_id)
        .outerjoin(User, User.id == Note.author_id)
        .where(Note.deleted_at.is_(None), Client.deleted_at.is_(None))
    )
    if user.role != "admin":
        query = query.where(Client.owner_id == user.id)
    if client_id:
        get_client_or_404(db, user, client_id)
        query = query.where(Note.client_id == client_id)
    if q and q.strip():
        # SQLAlchemy параметризует значение — инъекция через q невозможна.
        query = query.where(Note.body.ilike(f"%{q.strip()}%"))
    # Курсор пагинации: «покажи то, что старше последней загруженной заметки»
    if before:
        query = query.where(Note.created_at < before)

    rows = db.execute(query.order_by(Note.created_at.desc()).limit(limit)).all()
    if not rows:
        return {"items": [], "total": 0, "next_before": None, "has_more": False}

    note_ids = [note.id for note, _, _ in rows]
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
            # P0 AI Task Extraction 2.0: без этих полей интерфейс не может
            # отличить «ждём клиента» от «надо сделать» и показать вопрос
            # из уточнения (п.3, 8, 14).
            Task.event_kind,
            Task.actor,
            Task.review_question,
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
        event_kind,
        actor,
        review_question,
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
                "event_kind": event_kind,
                "actor": actor,
                "review_question": review_question,
            }
        )

    # п.18–19: кто реально обработал заметку. Отдельный запрос по всем заметкам
    # ленты, чтобы не делать N обращений к /notes/{id}/ai-status.
    run_rows = db.execute(
        select(AIRun.note_id, AIRun.model, AIRun.error)
        .where(AIRun.note_id.in_(note_ids))
        .order_by(AIRun.created_at.desc())
    ).all()
    ai_by_note: dict[str, dict] = {}
    for run_note_id, run_model, run_error in run_rows:
        # desc-порядок: первая строка на заметку — самый свежий прогон.
        if run_note_id in ai_by_note:
            continue
        fallback = bool(run_model and run_model.startswith("local-rules"))
        ai_by_note[run_note_id] = {
            "model": run_model,
            "used_fallback": fallback,
            "provider_note": _describe_run(run_model, run_error),
        }

    commit_rows = db.execute(
        select(
            Commitment.client_id,
            Commitment.description,
            Commitment.promised_by,
            Commitment.due_date,
            Commitment.source_quote,
            Commitment.related_task_id,
        ).where(Commitment.client_id.in_({note.client_id for note, _, _ in rows}))
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
    for note, client_name, author_name in rows:
        payload = NoteOut.model_validate(note).model_dump()
        payload["client_name"] = client_name
        payload["author_name"] = author_name
        linked = tasks_by_note.get(note.id, [])
        payload["task_count"] = len(linked)
        payload["open_task_count"] = sum(1 for t in linked if t["status"] == "open")
        payload["tasks"] = linked
        payload["commitments"] = commitments_by_note.get(note.id, [])
        # п.2 «30 идей»: итог одной строкой прямо в ленте, без отдельного
        # запроса /ai-status на каждую заметку. Выполненные отдаём отдельно,
        # чтобы «2 задачи» не превращались в «3 задачи» из-за закрытых.
        active_linked = [t for t in linked if t["status"] != "done"]
        done_linked = [t for t in linked if t["status"] == "done"]
        payload["summary"] = build_summary(
            tasks=active_linked,
            completed=done_linked,
            questions=sum(1 for t in active_linked if t["needs_review"]),
        ).model_dump()
        # п.18–19: даже в ленте видно, кто разобрал заметку и был ли fallback.
        payload.update(
            ai_by_note.get(
                note.id,
                {"model": None, "used_fallback": False, "provider_note": _describe_run(None, None)},
            )
        )
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
    query = (
        select(Note, User.full_name)
        .outerjoin(User, User.id == Note.author_id)
        .where(Note.client_id == client.id, Note.deleted_at.is_(None))
    )
    if before:
        query = query.where(Note.created_at < before)
    rows = list(db.execute(query.order_by(Note.created_at.desc()).limit(limit)).all())
    if not rows:
        return {"items": [], "total": 0}
    notes = [note for note, _ in rows]

    note_ids = [n.id for n in notes]
    task_rows = db.execute(
        select(Task.source_note_id, Task.id, Task.title, Task.status, Task.source_quote)
        .where(Task.source_note_id.in_(note_ids), Task.deleted_at.is_(None))
        .order_by(Task.created_at.asc())
    ).all()

    by_note: dict[str, list[dict]] = {}
    for note_id, task_id, title, task_status, source_quote in task_rows:
        by_note.setdefault(note_id, []).append(
            {"id": task_id, "title": title, "status": task_status, "source_quote": source_quote}
        )

    items = []
    for note, author_name in rows:
        payload = NoteOut.model_validate(note).model_dump()
        payload["author_name"] = author_name
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
    completed: list[dict] = []
    if runs and runs[0].result_json:
        try:
            parsed = json.loads(runs[0].result_json)
            needs_review = parsed.get("needs_review") or []
            completed = parsed.get("completed") or []
        except json.JSONDecodeError:
            needs_review = []
            completed = []

    # п.18, 19: показываем менеджеру, кто реально обработал заметку.
    # local-rules       — ключа провайдера нет, работали правила;
    # local-rules-fallback — AI упал (ошибка в ai_error), работали правила;
    # иначе             — ответила модель.
    model = runs[0].model if runs else None
    used_fallback = bool(model and model.startswith("local-rules"))

    # п.2 «30 идей»: сводка одной строкой. Считаем по задачам из БД
    # (источник правды), а не только по result_json: если разбор упал
    # на середине, задачи уже могли создаться.
    summary = build_summary(
        tasks=tasks,
        completed=completed,
        questions=needs_review,
    )

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
        tasks_created=summary.tasks,
        commitments_created=len([c for c in commitments if c.source_quote]),
        summary=summary,
        needs_review=needs_review,
        model=model,
        used_fallback=used_fallback,
        provider_note=_describe_run(model, runs[0].error if runs else None),
        completed=completed,
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


@router.post("/voice/audio")
def transcribe_audio(file: UploadFile = File(...), _: User = Depends(get_current_user)):
    if not settings.stt_base_url or not settings.stt_api_key:
        raise HTTPException(status_code=503, detail={"message": "Расшифровка аудио на сервере пока не настроена. Черновик сохранён в браузере."})
    variants = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav"}
    content_type = (file.content_type or "").split(";")[0]
    if content_type not in variants:
        raise HTTPException(status_code=422, detail={"message": "Поддерживаются записи WebM, Ogg, M4A и WAV."})
    limit = 10 * 1024 * 1024
    data = file.file.read(limit + 1)
    if not data or len(data) > limit:
        raise HTTPException(status_code=422, detail={"message": "Проверьте, что аудиозапись непустая и не превышает 10 МБ."})
    try:
        with httpx.Client(timeout=60) as client:
            response = client.post(
                settings.stt_base_url + "/audio/transcriptions",
                headers={"Authorization": f"Bearer {settings.stt_api_key}"},
                data={"model": settings.stt_model, "language": "ru"},
                files={"file": (f"note.{variants[content_type]}", data, content_type)},
            )
            response.raise_for_status()
            result = response.json()
            text = result.get("text") if isinstance(result, dict) else None
    except (httpx.HTTPError, ValueError):
        raise HTTPException(status_code=502, detail={"message": "Не удалось расшифровать запись. Черновик сохранён, можно попробовать ещё раз."})
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=422, detail={"message": "В записи не удалось распознать речь."})
    return {"text": text.strip()}
