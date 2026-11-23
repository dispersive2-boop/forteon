"""п.23 «30 идей»: утренний дайджест менеджера.

Почему именно так
-----------------
Менеджер не откроет систему, если не знает, что его там ждёт. Сводка должна
быть короткой: сколько на сегодня, сколько просрочено, что ждёт уточнения,
какие оплаты на неделе, есть ли просроченные счета. Не список задач.

Проверяем поведение:
  * пустой день даёт честный текст «нет задач», а не нули;
  * просроченное и сегодняшнее считаются раздельно;
  * задача «уточнить» не выдаётся за задачу на сегодня;
  * просроченный счёт виден только владельцу клиента;
  * время рассылки уважается, пустое — выключено;
  * повторная отправка в тот же день не плодит колокольчики.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings

assert "forteon_test" in _settings.database_url

from app.db import Base, engine  # noqa: E402
from app.models import Client, Invoice, Notification, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.services.digest import build_digest, digest_due, send_digest, send_due_digests  # noqa: E402

USER_ID = "dig-user-0000-0000-0000-00000000001"
OTHER_ID = "dig-user-0000-0000-0000-00000000002"
CLIENT_ID = "dig-client-0000-0000-0000-0000001"
FOREIGN_ID = "dig-client-0000-0000-0000-0000002"
TODAY = date(2026, 11, 23)


def _task(task_id: str, *, client_id: str = CLIENT_ID, due: date | None = None,
          kind: str = "todo", review: bool = False, assignee: str = USER_ID,
          type_: str = "task") -> Task:
    return Task(
        id=task_id, client_id=client_id, assignee_id=assignee, title=f"Задача {task_id}",
        status="open", due_date=due, event_kind=kind, needs_review=review, type=type_,
    )


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    session.add_all([
        User(id=USER_ID, email="dig@forteon.local", full_name="Менеджер Дайджест",
             password_hash=hash_password("Dig-pass-123"), role="manager", is_active=True,
             digest_time="09:00"),
        User(id=OTHER_ID, email="dig2@forteon.local", full_name="Другой Менеджер",
             password_hash=hash_password("Dig-pass-456"), role="manager", is_active=True,
             digest_time="09:00"),
    ])
    session.commit()
    session.add_all([
        Client(id=CLIENT_ID, name="Клиент дайджеста", owner_id=USER_ID, status="active"),
        Client(id=FOREIGN_ID, name="Чужой клиент", owner_id=OTHER_ID, status="active"),
    ])
    session.commit()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def test_empty_day_is_honest(db: Session) -> None:
    user = db.get(User, USER_ID)
    digest = build_digest(db, user, TODAY)
    assert digest.is_empty
    assert "нет задач" in digest.text()


def test_counts_today_and_overdue_separately(db: Session) -> None:
    db.add_all([
        _task("d-t-1", due=TODAY),
        _task("d-t-2", due=TODAY),
        _task("d-t-3", due=TODAY - timedelta(days=2)),
    ])
    db.commit()
    digest = build_digest(db, db.get(User, USER_ID), TODAY)
    assert digest.due_today == 2
    assert digest.overdue == 1
    text = digest.text()
    assert "на сегодня 2 задачи" in text
    assert "просрочено 1 задача" in text


def test_review_task_not_counted_as_today(db: Session) -> None:
    db.add(_task("d-r-1", due=TODAY, review=True))
    db.commit()
    digest = build_digest(db, db.get(User, USER_ID), TODAY)
    assert digest.due_today == 0, "Уточнение — ещё не задача на сегодня"
    assert digest.needs_review == 1


def test_foreign_overdue_invoice_not_visible(db: Session) -> None:
    db.add(Invoice(id="d-inv-1", client_id=FOREIGN_ID, amount=100000, status="issued",
                   due_date=TODAY - timedelta(days=5)))
    db.commit()
    digest = build_digest(db, db.get(User, USER_ID), TODAY)
    assert digest.invoices_overdue == 0, "Чужие счета не должны попадать в сводку"


def test_own_overdue_invoice_visible(db: Session) -> None:
    db.add(Invoice(id="d-inv-2", client_id=CLIENT_ID, amount=100000, status="issued",
                   due_date=TODAY - timedelta(days=5)))
    db.commit()
    digest = build_digest(db, db.get(User, USER_ID), TODAY)
    assert digest.invoices_overdue == 1


def test_foreign_tasks_not_counted(db: Session) -> None:
    db.add(_task("d-f-1", client_id=FOREIGN_ID, due=TODAY, assignee=OTHER_ID))
    db.commit()
    digest = build_digest(db, db.get(User, USER_ID), TODAY)
    assert digest.due_today == 0


def test_digest_time_respected(db: Session) -> None:
    user = db.get(User, USER_ID)
    user.digest_time = "09:00"
    assert digest_due(user, datetime(2026, 11, 23, 8, 59)) is False
    assert digest_due(user, datetime(2026, 11, 23, 9, 0)) is True
    assert digest_due(user, datetime(2026, 11, 23, 15, 0)) is True


def test_empty_digest_time_disables_sending(db: Session) -> None:
    user = db.get(User, USER_ID)
    user.digest_time = None
    assert digest_due(user, datetime(2026, 11, 23, 12, 0)) is False


def test_repeat_send_does_not_duplicate(db: Session) -> None:
    user = db.get(User, USER_ID)
    _, first = send_digest(db, user, TODAY)
    db.commit()
    _, second = send_digest(db, user, TODAY)
    db.commit()
    assert first is True
    assert second is False, "Повторная отправка обновляет то же уведомление"
    total = db.scalar(select(func.count()).select_from(Notification))
    assert total == 1


def test_send_due_digests_respects_time(db: Session) -> None:
    early = datetime(2026, 11, 23, 7, 0)
    assert send_due_digests(db, early) == 0
    db.commit()
    late = datetime(2026, 11, 23, 10, 0)
    assert send_due_digests(db, late) == 2, "Оба менеджера с временем 09:00"


def test_yesterday_digest_does_not_block_today(db: Session) -> None:
    user = db.get(User, USER_ID)
    send_digest(db, user, TODAY - timedelta(days=1))
    db.commit()
    _, created = send_digest(db, user, TODAY)
    db.commit()
    assert created is True, "Заголовок содержит дату — вчерашняя сводка не мешает"
