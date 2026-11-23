"""Применение результата AI к заметке: валидация, дедупликация, задачи, обязательства.

Ключевые правила (P0 «AI Task Extraction 2.0»):
  * срок и действие независимы — задача без даты создаётся (п.1, 2);
  * выполненные действия в задачи не попадают, но остаются в истории (п.4, 7);
  * ожидание от клиента даёт задачу контроля и обязательство (п.8, 9);
  * дедупликация не глушит законные повторы: ключ учитывает заметку (п.21, 22).
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

# Из обеих веток: личный план (ChatGPT) и апсерт напоминаний (п.22).
# Notification напрямую больше не нужен — его заменил upsert_reminder.
from ..models import (
    PERSONAL_PLAN_TYPE,
    AIRun,
    Client,
    Commitment,
    Note,
    Project,
    Task,
    User,
    utcnow,
)
from .notifications import upsert_reminder
from .ai import ExtractionResult, extract, make_dedupe_key
from .dates import to_date


def ensure_dedupe(task: Task) -> None:
    if not task.dedupe_key:
        task.dedupe_key = make_dedupe_key(task.client_id, task.title, task.due_at)


def _object_text(value: str) -> str:
    return " ".join(re.findall(r"\w+", value.casefold().replace("ё", "е")))


def _named_targets(db: Session, author: User) -> list[tuple[str, str, str | None]]:
    owned = [Client.deleted_at.is_(None), Client.type != PERSONAL_PLAN_TYPE]
    if author.role != "admin":
        owned.append(Client.owner_id == author.id)
    return [
        (_object_text(name), client_id, project_id)
        for name, client_id, project_id in db.execute(
            select(Project.name, Project.client_id, Project.id)
            .join(Client).where(*owned, Project.deleted_at.is_(None))
        )
    ]


def _match_target(
    targets: list[tuple[str, str, str | None]], source_quote: str, note_text: str,
) -> tuple[str, str | None] | None:
    quote = _object_text(source_quote)
    if not quote or f" {quote} " not in f" {note_text} ":
        return None
    matches = [
        (name, client_id, project_id) for name, client_id, project_id in targets
        if len(name) >= 3 and f" {name} " in f" {quote} "
    ]
    matches = [
        row for row in matches
        if not any(row[0] != name and f" {row[0]} " in f" {name} " for name, _, _ in matches)
    ]
    destinations = {(client_id, project_id) for _, client_id, project_id in matches}
    return next(iter(destinations)) if len(destinations) == 1 else None


def run_extraction(db: Session, note: Note, author: User) -> ExtractionResult:
    """Синхронный прогон AI для заметки. Возвращает результат и сохраняет задачи."""
    note_moment = note.created_at or utcnow()
    tz_name = note.note_timezone or author.timezone

    note.ai_status = "queued"
    db.flush()

    if note_moment.tzinfo is None:
        note_moment = note_moment.replace(tzinfo=timezone.utc)
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
                "completed": result.completed,
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
    review_tasks: list[Task] = []

    client = db.get(Client, note.client_id)
    targets = _named_targets(db, author) if client and client.type == PERSONAL_PLAN_TYPE else []
    normalized_note = _object_text(note.body) if targets else ""

    # Существующие ключи дедупликации по этой заметке.
    # Ключ учитывает note.id: повторная обработка ТОЙ ЖЕ заметки не создаёт
    # копий (п.21), но законный повтор того же действия из НОВОЙ заметки
    # проходит (п.22) — «созвонился» во вторник и в пятницу это два факта.
    existing = set(
        db.scalars(
            select(Task.dedupe_key).where(
                Task.source_note_id == note.id, Task.deleted_at.is_(None)
            )
        )
    )

    for item in result.tasks:
        key = make_dedupe_key(note.client_id, item.title, item.due_at, note.id)
        if key in existing:
            continue
        existing.add(key)

        # Уточнение нужно только когда непонятен сам тип события.
        # Отсутствие даты — НЕ причина отправлять в «Уточнить» (п.2, 13).
        needs_review = item.event_kind == "unclear"
        review_reason = None
        if needs_review:
            review_reason = item.review_question or "Непонятно, сделано уже или предстоит"

        client_id, project_id = _match_target(targets, item.source_quote, normalized_note) or (
            note.client_id, note.project_id,
        )
        task = Task(
            client_id=client_id,
            project_id=project_id,
            assignee_id=author.id,
            source_note_id=note.id,
            title=item.title,
            type=item.action_type,
            priority=item.priority,
            status="open",
            due_at=item.due_at,
            due_date=to_date(item.due_at, tz_name),
            timezone=tz_name,
            origin="ai",
            source_quote=item.source_quote,
            confidence=item.confidence,
            conditional=item.conditional,
            needs_review=needs_review,
            review_reason=review_reason,
            review_question=item.review_question if needs_review else None,
            event_kind=item.event_kind or "todo",
            actor=item.actor or "us",
            dedupe_key=key,
            description=item.due_reason if item.due_reason else None,
        )
        db.add(task)
        created_tasks += 1
        if needs_review:
            review_tasks.append(task)
        db.flush()

        for commitment in result.commitments:
            if commitment.description and _related(commitment.source_quote, item.source_quote):
                db.add(
                    Commitment(
                        client_id=client_id,
                        related_task_id=task.id,
                        promised_by=commitment.promised_by,
                        description=commitment.description,
                        due_date=to_date(commitment.due_at, tz_name),
                        status="open",
                        source_quote=commitment.source_quote,
                    )
                )
                created_commitments += 1

    # Обязательства без связи с задачей.
    # Ключевое отличие от прежней логики: обязательство клиента сохраняется
    # ВСЕГДА, даже если связанной задачи нет — иначе теряется, кто кому должен.
    linked = {c.source_quote for c in result.commitments if c.description}
    for commitment in result.commitments:
        if not commitment.description:
            continue
        matched = any(_related(commitment.source_quote, t.source_quote) for t in result.tasks)
        if matched and created_commitments:
            continue
        target = _match_target(targets, commitment.source_quote, normalized_note)
        db.add(
            Commitment(
                client_id=target[0] if target else note.client_id,
                promised_by=commitment.promised_by,
                description=commitment.description,
                due_date=to_date(commitment.due_at, tz_name),
                status="open",
                source_quote=commitment.source_quote,
            )
        )
        created_commitments += 1

    # Выполненные действия остаются в истории заметки (п.7), но не становятся
    # задачами. Пишем отдельной записью в тело заметки, чтобы факт не потерялся.
    if result.completed:
        lines = [c.get("description") or c.get("source_quote") for c in result.completed]
        lines = [line for line in lines if line]
        if lines:
            marker = "Выполнено (зафиксировано AI):"
            if marker not in (note.body or ""):
                note.body = (note.body or "").rstrip() + "\n\n" + marker + "\n" + "\n".join(
                    f"• {line}" for line in lines
                )

    # п.19: статус «failed» означает «задач нет и не будет» — иначе интерфейс
    # пишет менеджеру «задачи не созданы», хотя они перед ним на экране.
    # Причина ошибки всё равно сохраняется (она видна в прогоне AIRun и в
    # provider_note), но заметка считается разобранной, если задачи созданы.
    if review_tasks:
        # п.22 «30 идей»: повторный разбор той же заметки не должен копить
        # одинаковые колокольчики. Одно живое напоминание на задачу.
        upsert_reminder(
            db,
            user_id=author.id,
            task_id=review_tasks[0].id,
            title="Нужно проверить разбор заметки",
            body=review_tasks[0].review_question or "Откройте задачи, которые требуют уточнения.",
        )

    produced_something = bool(result.tasks or result.commitments or result.completed)
    if result.error and not produced_something:
        note.ai_status = "failed"
    else:
        note.ai_status = "ok"
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
