"""P0 AI Task Extraction 2.0 — поведение извлечения задач.

Проверяем именно поведение (п.24):
  * выполненные действия не становятся задачами;
  * ожидание от клиента даёт задачу контроля и обязательство;
  * разговорный текст без «надо/нужно» распознаётся;
  * задача без срока создаётся и НЕ уходит в «Уточнить»;
  * в уточнение попадает только неясный тип события, с конкретным вопросом;
  * дедупликация не глушит законный повтор из другой заметки.

Изоляция от боевой БД задаётся один раз в tests/conftest.py (pytest грузит его
раньше тестовых модулей). Здесь остаётся только страховка: если движок всё же
смотрит на боевой файл — падаем до drop_all(), а не после.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.config import settings as _settings

assert _settings.database_url.startswith("sqlite"), (
    "Тест ждёт SQLite-файл, получено: %s" % _settings.database_url
)
assert "forteon_test" in _settings.database_url, (
    "Тест подключён к боевой БД (%s). Проверьте tests/conftest.py."
    % _settings.database_url
)

from sqlalchemy import delete, select  # noqa: E402

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import Client, Note, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.services.ai import local_extract, make_dedupe_key  # noqa: E402
from app.services.events import (  # noqa: E402
    DONE,
    FACT,
    TODO,
    UNCLEAR,
    WAITING,
    classify,
    review_question,
)
from app.services.extraction import run_extraction  # noqa: E402

NOW = datetime(2026, 11, 20, 9, 0, tzinfo=timezone.utc)
TZ = "Asia/Yekaterinburg"


# ---------------------------------------------------------------- классификация

@pytest.mark.parametrize(
    "phrase,expected",
    [
        # п.4, 6: прошедшее время — уже сделано
        ("Отправил КП клиенту", DONE),
        ("Согласовали договор с юристом", DONE),
        ("Обсудили условия по телефону", DONE),
        ("Встретились с директором", DONE),
        ("Оплатили счёт", DONE),
        # п.6, 8: ожидание от клиента
        ("Ждём ответ от бухгалтерии", WAITING),
        ("Обещали прислать реквизиты", WAITING),
        ("Клиент должен оплатить", WAITING),
        ("Нет ответа от заказчика", WAITING),
        ("Попросили прислать документы", WAITING),
        # п.5: разговорный текст без «надо»
        ("Позвоню в пятницу", TODO),
        ("Перезвоню завтра", TODO),
        ("Надо подготовить КП", TODO),
        ("Отправить счёт", TODO),
        # п.13: неясно, с конкретным вопросом
        ("Переговоры прошли хорошо", UNCLEAR),
        # факт и отрицание
        ("Погода хорошая", FACT),
        ("Не надо звонить клиенту", FACT),
        ("Отменили встречу", FACT),
    ],
)
def test_classify(phrase: str, expected: str) -> None:
    assert classify(phrase).kind == expected


def test_done_not_confused_with_infinitive() -> None:
    """«Отправил» не должно считаться инфинитивом «отправить».

    Регрессия: проверка императива по корню «отправ» отменяла распознавание
    прошедшего времени, и задача создавалась на уже выполненное действие.
    """
    assert classify("Отправил КП клиенту").kind == DONE
    assert classify("Отправить КП клиенту").kind == TODO


def test_review_question_is_concrete() -> None:
    """п.14: вопрос должен быть понятным, а не «уточните»."""
    event = classify("Переговоры прошли хорошо")
    question = review_question(event)
    assert "?" in question
    assert "уточните" not in question.lower()
    assert len(question) > 20


# ---------------------------------------------------------------- извлечение

def test_completed_not_tasks() -> None:
    """п.4, 7: выполненное не создаёт задачу, но попадает в историю."""
    result = local_extract("Отправил КП. Согласовали договор.", NOW, TZ)
    titles = " ".join(t.title.lower() for t in result.tasks)
    assert "отправил" not in titles
    assert "согласовали" not in titles
    assert len(result.completed) == 2


def test_waiting_gives_control_task_and_commitment() -> None:
    """п.8, 9: ожидание даёт задачу контроля и обязательство клиента."""
    result = local_extract("Ждём ответ от бухгалтерии.", NOW, TZ)
    assert any("проконтролировать" in t.title.lower() for t in result.tasks)
    assert any(t.event_kind == WAITING and t.actor == "client" for t in result.tasks)
    assert any(c.promised_by == "client" for c in result.commitments)


def test_task_without_due_date_is_not_review() -> None:
    """п.2, 13: нет даты — задача всё равно создаётся, но не в «Уточнить»."""
    result = local_extract("Надо подготовить КП.", NOW, TZ)
    assert len(result.tasks) == 1
    task = result.tasks[0]
    assert task.due_at is None
    assert task.event_kind == TODO
    assert task.review_question is None
    assert result.needs_review == []


def test_unclear_goes_to_review_with_question() -> None:
    """п.13, 14: в уточнение — только неясное, и с вопросом."""
    result = local_extract("Переговоры прошли хорошо.", NOW, TZ)
    assert len(result.needs_review) == 1
    assert "?" in result.needs_review[0]["reason"]


def test_relative_date_uses_note_time() -> None:
    """п.12: относительная дата считается от времени заметки."""
    result = local_extract("Позвоню в пятницу.", NOW, TZ)
    assert result.tasks, "задача должна создаться"
    due = result.tasks[0].due_at
    assert due is not None, "«в пятницу» должно дать дату"
    assert due.date() >= NOW.date()


def test_no_invented_facts() -> None:
    """п.10: не выдумываем сроки и исполнителей, которых нет в тексте."""
    result = local_extract("Надо подготовить КП.", NOW, TZ)
    task = result.tasks[0]
    assert task.due_at is None, "срок нельзя придумывать"
    assert "клиент" not in (task.title or "").lower()


# ---------------------------------------------------------------- дедупликация

def test_dedupe_key_includes_note() -> None:
    """п.21, 22: ключ зависит от заметки — повтор из новой заметки проходит."""
    a = make_dedupe_key("client-1", "Позвонить", NOW, "note-1")
    b = make_dedupe_key("client-1", "Позвонить", NOW, "note-2")
    same = make_dedupe_key("client-1", "Позвонить", NOW, "note-1")
    assert a != b, "разные заметки — разные задачи (законный повтор)"
    assert a == same, "повторная обработка той же заметки не создаёт копию"


# ---------------------------------------------------------------- интеграция

@pytest.fixture()
def db_session():
    """Чистая БД и менеджер с клиентом — как в бою, но изолированно."""
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    user = User(
        email="extract-tester@forteon.local",
        full_name="Тестировщик извлечения",
        password_hash=hash_password("Test-pass-123"),
        role="manager",
        is_active=True,
        timezone=TZ,
    )
    session.add(user)
    session.flush()
    client = Client(owner_id=user.id, type="legal", name="Тест Клиент", status="active")
    session.add(client)
    session.commit()
    try:
        yield session, user, client
    finally:
        session.close()


def test_pipeline_note_to_planner(db_session) -> None:
    """п.25: заметка → извлечение → БД → API-представление планировщика."""
    session, user, client = db_session

    note = Note(
        client_id=client.id,
        author_id=user.id,
        body=(
            "Отправил КП клиенту. Согласовали договор с юристом. "
            "Ждём ответ от бухгалтерии. Позвоню в пятницу. Надо подготовить счёт."
        ),
        source_type="text",
        ai_status="pending",
        note_timezone=TZ,
    )
    session.add(note)
    session.commit()

    result = run_extraction(session, note, user)
    session.commit()

    # 1. В истории заметки зафиксировано выполненное
    assert "Выполнено" in note.body
    assert len(result.completed) == 2

    # 2. Задачи в БД
    tasks = list(session.scalars(select(Task).where(Task.source_note_id == note.id)))
    assert tasks, "задачи должны появиться в БД"

    titles = " ".join(t.title.lower() for t in tasks)
    assert "отправил" not in titles, "выполненное не должно стать задачей"

    # 3. Задача без срока существует и не помечена «на уточнение»
    without_due = [t for t in tasks if t.due_date is None]
    assert without_due, "задача без срока должна остаться в списке"
    assert all(not t.needs_review for t in without_due)

    # 4. Ожидание помечено actor=client
    assert any(t.actor == "client" for t in tasks)

    # 5. У каждой задачи есть исходная цитата (п.17)
    assert all(t.source_quote for t in tasks), "нужна цитата у каждой задачи"

    # 6. Уточнение только с конкретным вопросом
    review = [t for t in tasks if t.needs_review]
    for task in review:
        assert task.review_question and "?" in task.review_question

    # 7. Повторная обработка той же заметки не плодит копии (п.21)
    before = len(tasks)
    run_extraction(session, note, user)
    session.commit()
    after = list(session.scalars(select(Task).where(Task.source_note_id == note.id)))
    assert len(after) == before, "повторный прогон не должен создавать копии"

    # 8. Новая заметка с тем же действием создаёт новую задачу (п.22)
    second = Note(
        client_id=client.id,
        author_id=user.id,
        body="Позвоню в пятницу.",
        source_type="text",
        ai_status="pending",
        note_timezone=TZ,
    )
    session.add(second)
    session.commit()
    run_extraction(session, second, user)
    session.commit()

    second_tasks = list(session.scalars(select(Task).where(Task.source_note_id == second.id)))
    assert second_tasks, "то же действие из новой заметки — законный повтор"
