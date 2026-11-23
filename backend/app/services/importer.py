"""Импорт «Отчетная таблица Гришанов к совещанию 16.11.2026.xlsx» (раздел 10).

Буквальный перенос структуры Excel в интерфейс не выполняется: строки объекта
преобразуются в клиента, проект, историю (заметку), задачи следующего спринта
и проблемы/риски. Повторный импорт идемпотентен — объекты ищутся по названию.
"""
from __future__ import annotations

import hashlib
import re
from contextlib import closing
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

import openpyxl
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..deps import audit
from ..models import PERSONAL_PLAN_TYPE, Client, Note, Project, Task, User, utcnow
from .ai import make_dedupe_key, normalize_title
from .dates import extract_due, to_date

COLUMNS = {
    "name": 1,
    "status": 2,
    "location": 3,
    "received_at": 4,
    "volume": 5,
    "planned_revenue": 6,
    "service": 7,
    "done_before": 8,
    "done_last_sprint": 9,
    "plan_next_sprint": 10,
    "problems": 11,
    "meeting_comment": 12,
}

SECTION_HINTS = ("проекты в реализации", "эшелон", "архив", "перспектив", "проекты 202")


@dataclass(frozen=True)
class DuplicateRow:
    """Одна строка файла, которая уже есть в базе (п.12 «30 идей»).

    Храним не только название, но и строку таблицы и клиента: в предпросмотре
    менеджеру нужно открыть этот файл, найти строку 47 и убедиться, что дубль
    настоящий, а не склейка разных дел с одинаковым заголовком.
    """

    row: int
    client_name: str
    task_title: str


@dataclass
class ImportStats:
    clients_created: int = 0
    clients_reused: int = 0
    projects_created: int = 0
    tasks_created: int = 0
    problems_created: int = 0
    skipped_rows: list[int] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # п.12 «30 идей»: строки, которые уже есть в базе.
    # Без этого счётчика повторный импорт выглядел как «создано 120»,
    # хотя 120 задач уже существовали — и менеджер считал, что данных
    # стало вдвое больше.
    duplicates_skipped: int = 0
    duplicate_rows: list[DuplicateRow] = field(default_factory=list)


def _text(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _number(value) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = re.sub(r"[^\d,.\-]", "", str(value)).replace(",", ".")
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def _as_date(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        for fmt in ("%d.%m.%Y", "%Y-%m-%d", "%d.%m.%y", "%m.%Y", "%Y"):
            try:
                return datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                continue
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})", value)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def split_items(raw: str | None) -> list[str]:
    if not raw:
        return []
    parts = re.split(r"[;\n•]|(?<!\d),(?!\d)", raw)
    items = []
    for part in parts:
        cleaned = part.strip(" .-–—")
        if len(cleaned) >= 3 and not re.fullmatch(r"[-\s]+", cleaned):
            items.append(cleaned)
    return items


def _is_section_row(values: list) -> tuple[bool, str | None]:
    first = values[0]
    if first is None:
        return False, None
    if any(v not in (None, "") for v in values[1:]):
        return False, None
    text = str(first).strip()
    if not text:
        return False, None
    low = text.lower()
    if len(text) > 140 or not any(hint in low for hint in SECTION_HINTS):
        return False, None
    return True, text


def import_xlsx(db: Session, path: str | Path, owner: User) -> ImportStats:
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Файл не найден: {path}")

    with closing(openpyxl.load_workbook(path, read_only=True, data_only=True)) as wb:
        rows = list(wb.worksheets[0].iter_rows(min_row=2, max_col=max(COLUMNS.values()), values_only=True))
    stats = ImportStats()
    section = "Импорт"
    report_match = re.search(r"\d{1,2}\.\d{1,2}\.\d{4}", path.name)
    report_date = _as_date(report_match[0]) if report_match else None
    report_moment = datetime.combine(report_date, datetime.min.time(), tzinfo=timezone.utc) if report_date else None

    for row_idx, values in enumerate(rows, start=2):
        is_section, section_title = _is_section_row(values)
        if is_section:
            section = section_title or section
            continue

        name = _text(values[COLUMNS["name"] - 1])
        if not name:
            continue
        # Служебные строки без статуса/локации и с «шапкой» пропускаем
        low_name = name.lower()
        if low_name.startswith(("наименование", "статус", "итого")):
            continue

        status = _text(values[COLUMNS["status"] - 1]) or "new"
        location = _text(values[COLUMNS["location"] - 1])
        received_at = _as_date(values[COLUMNS["received_at"] - 1])
        volume = _number(values[COLUMNS["volume"] - 1])
        planned_revenue = _number(values[COLUMNS["planned_revenue"] - 1])
        service = _text(values[COLUMNS["service"] - 1])
        done_before = _text(values[COLUMNS["done_before"] - 1])
        done_last = _text(values[COLUMNS["done_last_sprint"] - 1])
        next_sprint = _text(values[COLUMNS["plan_next_sprint"] - 1])
        problems = _text(values[COLUMNS["problems"] - 1])
        comment = _text(values[COLUMNS["meeting_comment"] - 1])

        if not any(value is not None for value in values[1:]):
            stats.skipped_rows.append(row_idx)
            continue

        client = db.scalar(
            select(Client).where(
                Client.owner_id == owner.id,
                Client.name == name,
                Client.deleted_at.is_(None),
                Client.type != PERSONAL_PLAN_TYPE,
            )
        )
        if client is None:
            client = Client(
                owner_id=owner.id,
                type="legal",
                name=name,
                legal_name=name,
                address=location,
                status="active",
                notes_public=comment,
            )
            db.add(client)
            db.flush()
            stats.clients_created += 1
        else:
            stats.clients_reused += 1
            if location and not client.address:
                client.address = location

        project = db.scalar(
            select(Project).where(
                Project.client_id == client.id,
                Project.name == name,
                Project.deleted_at.is_(None),
            )
        )
        if project is None:
            project = Project(
                client_id=client.id,
                name=name,
                location=location,
                status=status,
                stage_group=section,
                start_date=received_at,
                volume=volume,
                planned_revenue=planned_revenue,
                service_flag=service,
                done_before=done_before,
                done_last_sprint=done_last,
                plan_next_sprint=next_sprint,
                problems_text=problems,
                meeting_comment=comment,
                source_row=row_idx,
            )
            db.add(project)
            db.flush()
            stats.projects_created += 1
            # п.14 «30 идей»: без этой записи история проекта пуста, и на
            # вопрос «откуда эта сумма» ответить нечем. Пишем тот же формат,
            # что и ручное создание через API.
            audit(db, owner, "project", project.id, "created", {
                "client_id": client.id, "source_row": row_idx, "origin": "import",
            })
        else:
            project.location = project.location or location
            project.status = status or project.status
            project.stage_group = project.stage_group or section
            project.start_date = project.start_date or received_at
            project.volume = project.volume if project.volume is not None else volume
            project.planned_revenue = (
                project.planned_revenue if project.planned_revenue is not None else planned_revenue
            )
            project.service_flag = project.service_flag or service
            project.done_before = project.done_before or done_before
            project.done_last_sprint = project.done_last_sprint or done_last
            project.plan_next_sprint = project.plan_next_sprint or next_sprint
            project.problems_text = project.problems_text or problems
            project.meeting_comment = project.meeting_comment or comment
            project.version = (project.version or 1) + 1

        # История: заметка-импорт с контекстом строки
        history_lines = []
        if done_before:
            history_lines.append(f"Сделано ранее: {done_before}")
        if done_last:
            history_lines.append(f"Сделано за последний спринт: {done_last}")
        if next_sprint:
            history_lines.append(f"Следующий спринт: {next_sprint}")
        if problems:
            history_lines.append(f"Проблемы и сроки: {problems}")
        if comment:
            history_lines.append(f"Комментарий совещания: {comment}")

        if history_lines:
            body = "\n".join(history_lines)
            signature = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
            note_key = f"import:project:{project.id}:{signature}"
            exists = db.scalar(
                select(Note.id).where(
                    Note.client_id == client.id,
                    Note.project_id == project.id,
                    Note.source_type == "import",
                    Note.body == body,
                    Note.deleted_at.is_(None),
                ).limit(1)
            )
            if exists is None:
                db.add(
                    Note(
                        client_id=client.id,
                        project_id=project.id,
                        author_id=owner.id,
                        body=body,
                        source_type="import",
                        ai_status="imported",
                        idempotency_key=note_key,
                        note_timezone=owner.timezone,
                    )
                )

        # Задачи следующего спринта
        existing_keys = set(
            db.scalars(
                select(Task.dedupe_key).where(Task.client_id == client.id, Task.deleted_at.is_(None))
            )
        )
        due_hint = _as_date(problems)

        for item in split_items(next_sprint):
            key = make_dedupe_key(client.id, item, None)
            if key in existing_keys or normalize_title(item) in {""}:
                # Уже есть — считаем, но не создаём. Это и есть п.12.
                if key in existing_keys:
                    stats.duplicates_skipped += 1
                    if len(stats.duplicate_rows) < 50:
                        stats.duplicate_rows.append(
                            DuplicateRow(row=row_idx, client_name=name, task_title=item[:160])
                        )
                continue
            existing_keys.add(key)
            due_at, _ = extract_due(item, report_moment, owner.timezone) if report_moment else (None, None)
            db.add(
                Task(
                    client_id=client.id,
                    project_id=project.id,
                    assignee_id=owner.id,
                    title=item[:480],
                    due_at=due_at,
                    due_date=to_date(due_at, owner.timezone),
                    type="other",
                    priority="high" if problems else "normal",
                    status="open",
                    origin="import",
                    needs_review=False,
                    dedupe_key=key,
                    timezone=owner.timezone,
                )
            )
            stats.tasks_created += 1

        # Проблемы → отдельные задачи-контроля
        if problems:
            for item in split_items(problems):
                low = item.lower()
                if not any(w in low for w in ("проблем", "риск", "просроч", "долг", "задолж",
                                              "нет", "ждём", "ждем", "блок", "не ")):
                    continue
                key = make_dedupe_key(client.id, "Проблема: " + item, None)
                if key in existing_keys:
                    stats.duplicates_skipped += 1
                    if len(stats.duplicate_rows) < 50:
                        stats.duplicate_rows.append(
                            DuplicateRow(
                                row=row_idx,
                                client_name=name,
                                task_title=("Проблема: " + item)[:160],
                            )
                        )
                    continue
                existing_keys.add(key)
                db.add(
                    Task(
                        client_id=client.id,
                        project_id=project.id,
                        assignee_id=owner.id,
                        title=("Проблема: " + item)[:480],
                        source_quote=item,
                        type="other",
                        priority="critical",
                        status="open",
                        due_date=due_hint,
                        due_at=None,
                        origin="import",
                        needs_review=due_hint is None,
                        review_reason=None if due_hint else "Ответственный и срок требуют уточнения",
                        dedupe_key=key,
                        timezone=owner.timezone,
                    )
                )
                stats.problems_created += 1
                stats.tasks_created += 1

    db.flush()
    return stats
