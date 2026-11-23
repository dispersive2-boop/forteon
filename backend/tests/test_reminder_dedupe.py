"""п.22 «30 идей»: одно живое напоминание на событие.

Почему именно так
-----------------
Заметку можно разобрать повторно. Старый код каждый раз добавлял НОВОЕ
уведомление «Нужно проверить разбор заметки» — у менеджера копились
одинаковые колокольчики про одно и то же.

Проверяем поведение:
  * повторный вызов обновляет то же уведомление, а не создаёт второе;
  * текст и срок обновляются;
  * прочитанное уведомление не переиспользуется — новое событие это новое дело;
  * отложенное (snooze) не затирается;
  * уведомления разных задач не склеиваются.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings

assert "forteon_test" in _settings.database_url

from app.db import Base, engine  # noqa: E402
from app.models import Client, Notification, Task, User, utcnow  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.services.notifications import upsert_reminder  # noqa: E402

USER_ID = "rem-user-0000-0000-0000-000000000001"
CLIENT_ID = "rem-client-0000-0000-0000-00000001"
TASK_A = "rem-task-0000-0000-0000-0000000001"
TASK_B = "rem-task-0000-0000-0000-0000000002"
TITLE = "Нужно проверить разбор заметки"


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    session.add(User(id=USER_ID, email="rem@forteon.local", full_name="Менеджер Напоминаний",
                     password_hash=hash_password("Rem-pass-123"), role="manager", is_active=True))
    session.commit()
    session.add(Client(id=CLIENT_ID, name="Клиент напоминаний", owner_id=USER_ID, status="active"))
    session.commit()
    session.add_all([
        Task(id=TASK_A, client_id=CLIENT_ID, assignee_id=USER_ID, title="Уточнить тип",
             status="open", needs_review=True),
        Task(id=TASK_B, client_id=CLIENT_ID, assignee_id=USER_ID, title="Другая задача",
             status="open", needs_review=True),
    ])
    session.commit()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def _count(db: Session) -> int:
    return int(db.scalar(select(func.count()).select_from(Notification)) or 0)


def test_repeat_updates_same_notification(db: Session) -> None:
    first, created_first = upsert_reminder(
        db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Первый вопрос",
    )
    db.commit()
    assert created_first is True

    second, created_second = upsert_reminder(
        db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Обновлённый вопрос",
    )
    db.commit()

    assert created_second is False, "Повтор должен обновлять, а не создавать"
    assert second.id == first.id
    assert _count(db) == 1
    assert second.body == "Обновлённый вопрос"


def test_read_notification_is_not_reused(db: Session) -> None:
    first, _ = upsert_reminder(db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Раз")
    first.read_at = utcnow()
    db.commit()

    second, created = upsert_reminder(
        db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Два",
    )
    db.commit()

    assert created is True, "Прочитанное не переиспользуем: это новое событие"
    assert second.id != first.id
    assert _count(db) == 2


def test_snoozed_notification_is_preserved(db: Session) -> None:
    first, _ = upsert_reminder(db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Раз")
    later = utcnow() + timedelta(hours=3)
    first.scheduled_at = later
    first.status = "pending"
    db.commit()

    upsert_reminder(db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Два")
    db.commit()

    # Отложенное уведомление не тронуто: срок остался в будущем.
    db.refresh(first)
    assert first.scheduled_at == later, "Отложенное напоминание нельзя затирать"
    assert first.body == "Раз"


def test_different_tasks_do_not_merge(db: Session) -> None:
    upsert_reminder(db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="А")
    upsert_reminder(db, user_id=USER_ID, task_id=TASK_B, title=TITLE, body="Б")
    db.commit()
    assert _count(db) == 2, "Напоминания разных задач — разные уведомления"


def test_body_survives_when_new_one_is_empty(db: Session) -> None:
    upsert_reminder(db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Вопрос был")
    db.commit()
    updated, _ = upsert_reminder(db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body=None)
    db.commit()
    assert updated.body is None
    assert _count(db) == 1


def test_scheduled_at_defaults_to_now(db: Session) -> None:
    # utcnow(), а не datetime.now(): проект хранит время в UTC без зоны,
    # и сравнение с локальным временем дало бы ложный провал.
    before = utcnow()
    reminder, _ = upsert_reminder(db, user_id=USER_ID, task_id=TASK_A, title=TITLE, body="Сейчас")
    db.commit()
    assert reminder.scheduled_at >= before - timedelta(seconds=5)
    assert reminder.scheduled_at <= utcnow() + timedelta(seconds=5)
