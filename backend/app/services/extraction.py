"""Применение результата AI к заметке: валидация, дедупликация, задачи, обязательства."""
from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import AIRun, Commitment, Note, Task, User, utcnow
from .ai import ExtractionResult, extract, make_dedupe_key
from .dates import to_date


def ensure_dedupe(task: Task) -> None:
    if not task.dedupe_key:
        task.dedupe_key = make_dedupe_key(task.client_id, task.title, task.due_at)


def run_extraction(db: Session, note: Note, author: User) -> ExtractionResult:
    """Синхронный прогон AI для заметки. Возвращает результат и сохраняет задачи."""
    note_moment = note.created_at or utcnow()
    tz_name = note.note_timezone or author.timezone

    note.ai_status = "queued"
    db.flush()

    result = extract(note.body, note_moment, tz_name)

    ai_run = AIRun(
        note_id=note.id,
        model=result.model,
        prompt_version=result.prompt_version,
        status="ok" if not result.error else "fallback",
        tokens=result.tokens,
        cost=result.cost,
        result_json=json.dumps(
            {
                "tasks": [t.__dict__ for t in result.tasks],
                "commitments": [c.__dict__ for c in result.commitments],
                "needs_review": result.needs_review,
            },
            ensure_ascii=False,
            default=str,
        ),
        error=result.error,
    )
    db.add(ai_run)

    created_tasks = 0
    created_commitments = 0

    # Существующие ключи дедупликации по этому клиенту
    existing = set(
        db.scalars(select(Task.dedupe_key).where(Task.client_id == note.client_id, Task.deleted_at.is_(None)))
    )

    for item in result.tasks:
        key = make_dedupe_key(note.client_id, item.title, item.due_at)
        if key in existing:
            continue
        existing.add(key)
        task = Task(
            client_id=note.client_id,
            project_id=note.project_id,
            assignee_id=author.id,
            source_note_id=note.id,
            title=item.title,
            type=item.action_type,
            priority=item.priority,
            status="open",
            due_at=item.due_at,
            due_date=to_date(item.due_at),
            timezone=tz_name,
            origin="ai",
            source_quote=item.source_quote,
            confidence=item.confidence,
            conditional=item.conditional,
            needs_review=item.due_at is None,
            review_reason="Срок не определён однозначно" if item.due_at is None else None,
            dedupe_key=key,
        )
        db.add(task)
        created_tasks += 1
        db.flush()

        for commitment in result.commitments:
            if commitment.description and _related(commitment.source_quote, item.source_quote):
                db.add(
                    Commitment(
                        client_id=note.client_id,
                        related_task_id=task.id,
                        promised_by=commitment.promised_by,
                        description=commitment.description,
                        due_date=to_date(commitment.due_at),
                        status="open",
                        source_quote=commitment.source_quote,
                    )
                )
                created_commitments += 1

    # Обязательства без связи с задачей
    linked_quotes = {c.source_quote for c in result.commitments if c.description}
    for commitment in result.commitments:
        if commitment.source_quote in linked_quotes and created_commitments and any(
            _related(commitment.source_quote, t.source_quote) for t in result.tasks
        ):
            continue
        db.add(
            Commitment(
                client_id=note.client_id,
                promised_by=commitment.promised_by,
                description=commitment.description,
                due_date=to_date(commitment.due_at),
                status="open",
                source_quote=commitment.source_quote,
            )
        )
        created_commitments += 1

    note.ai_status = "ok" if not result.error else "failed"
    note.ai_error = result.error
    note.version = (note.version or 1) + 1
    result.needs_review = result.needs_review or []
    db.flush()
    return result


def _related(a: str, b: str) -> bool:
    a = (a or "").strip().lower()
    b = (b or "").strip().lower()
    if not a or not b:
        return False
    return a[:60] == b[:60] or a[:40] in b or b[:40] in a


def parse_note_time(note: Note) -> datetime:
    return note.created_at or utcnow()
