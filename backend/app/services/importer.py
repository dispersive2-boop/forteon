"""Импорт «Отчетная таблица Гришанов к совещанию 16.11.2026.xlsx» (раздел 10).

Буквальный перенос структуры Excel в интерфейс не выполняется: строки объекта
преобразуются в клиента, проект, историю (заметку), задачи следующего спринта
и проблемы/риски. Повторный импорт идемпотентен — объекты ищутся по названию.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import openpyxl
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Client, ClientContact, Note, Project, Task, User, utcnow
from .ai import make_dedupe_key, normalize_title

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


@dataclass
class ImportStats:
    clients_created: int = 0
    clients_reused: int = 0
    projects_created: int = 0
    tasks_created: int = 0
    problems_created: int = 0
    skipped_rows: list[int] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


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

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]
    stats = ImportStats()
    section = "Импорт"

    for row_idx in range(2, ws.max_row + 1):
        values = [ws.cell(row=row_idx, column=c).value for c in range(1, 13)]
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

        if not any((status != "new", location, planned_revenue, done_before, done_last, next_sprint, problems)):
            stats.skipped_rows.append(row_idx)
            continue

        client = db.scalar(
            select(Client).where(
                Client.owner_id == owner.id,
                Client.name == name,
                Client.deleted_at.is_(None),
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
            db.add(
                ClientContact(
                    client_id=client.id,
                    name="Контакт из отчёта",
                    position="Основной контакт",
                    is_primary=False,
                )
            )
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
            note_key = f"import:{path.name}:{row_idx}"
            exists = db.scalar(
                select(Note).where(
                    Note.client_id == client.id,
                    Note.idempotency_key == note_key,
                )
            )
            if exists is None:
                db.add(
                    Note(
                        client_id=client.id,
                        project_id=project.id,
                        author_id=owner.id,
                        body="\n".join(history_lines),
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
                continue
            existing_keys.add(key)
            db.add(
                Task(
                    client_id=client.id,
                    project_id=project.id,
                    assignee_id=owner.id,
                    title=item[:480],
                    type="other",
                    priority="high" if problems else "normal",
                    status="open",
                    origin="import",
                    needs_review=True,
                    review_reason="Срок из отчёта не определён однозначно",
                    dedupe_key=key,
                    timezone=owner.timezone,
                )
            )
            stats.tasks_created += 1

        # Проблемы → отдельные задачи-контроля
        if problems:
            responsible_match = re.search(r"([А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)", problems)
            for item in split_items(problems):
                low = item.lower()
                if not any(w in low for w in ("проблем", "риск", "просроч", "долг", "задолж",
                                              "нет", "ждём", "ждем", "блок", "не ")):
                    continue
                key = make_dedupe_key(client.id, "Проблема: " + item, None)
                if key in existing_keys:
                    continue
                existing_keys.add(key)
                db.add(
                    Task(
                        client_id=client.id,
                        project_id=project.id,
                        assignee_id=owner.id,
                        title=("Проблема: " + item)[:480],
                        description=responsible_match.group(1) if responsible_match else None,
                        type="other",
                        priority="critical",
                        status="open",
                        due_date=due_hint,
                        due_at=datetime.combine(due_hint, datetime.min.time()) if due_hint else None,
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
