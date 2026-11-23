"""п.19 и п.20 «30 идей»: следующий шаг и риск с причиной.

Почему именно так
-----------------
Список клиентов раньше показывал только название. Менеджеру приходилось
открывать карточки подряд, чтобы понять, за что взяться. Две подсказки
убирают эту работу, но они ценны только если им можно верить:

  * следующий шаг — конкретное дело, и просрочка важнее будущего срока;
  * риск — с причиной и уровнем, а деньги весят больше задач;
  * клиент без задач и без риска не подсвечивается вовсе — иначе «риск»
    перестанет что-либо значить.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings

assert "forteon_test" in _settings.database_url

from app.db import Base, engine, get_db  # noqa: E402
from app.deps import get_current_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Client, ClientContact, Invoice, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402

USER_ID = "signals-user-0000-0000-0000-000000000001"
QUIET_ID = "signals-client-0000-0000-0000-00000000a"
OVERDUE_ID = "signals-client-0000-0000-0000-00000000b"
WAITING_ID = "signals-client-0000-0000-0000-00000000c"
PAID_ID = "signals-client-0000-0000-0000-00000000d"
NOCONTACT_ID = "signals-client-0000-0000-0000-00000000e"

NOW = datetime(2026, 11, 23, 9, 0, tzinfo=timezone.utc)
TODAY = NOW.date()


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    session.add(
        User(
            id=USER_ID,
            email="signals@forteon.local",
            full_name="Менеджер Сигналов",
            password_hash=hash_password("Signals-pass-123"),
            role="manager",
            is_active=True,
        )
    )
    for client_id, name in (
        (QUIET_ID, "Тихий клиент"),
        (OVERDUE_ID, "Просроченный клиент"),
        (WAITING_ID, "Ждущий клиент"),
        (PAID_ID, "Должник"),
        (NOCONTACT_ID, "Без контактов"),
    ):
        session.add(Client(id=client_id, name=name, owner_id=USER_ID, status="active"))
    session.commit()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def api(db: Session) -> Iterator[TestClient]:
    def _db() -> Iterator[Session]:
        yield db

    def _user() -> User:
        return db.get(User, USER_ID)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _task(db: Session, client_id: str, title: str, *, due: datetime | None = None,
          kind: str = "todo") -> Task:
    task = Task(
        client_id=client_id,
        assignee_id=USER_ID,
        title=title,
        type="other",
        priority="normal",
        status="open",
        event_kind=kind,
        due_date=due.date() if due else None,
        due_at=due,
        timezone="Asia/Yekaterinburg",
        created_at=due or NOW,
        updated_at=due or NOW,
    )
    db.add(task)
    return task


def _signals(api: TestClient) -> dict[str, dict]:
    response = api.get("/api/v1/clients", params={"limit": 50})
    assert response.status_code == 200, response.text
    return {item["id"]: item for item in response.json()["items"]}


def test_quiet_client_has_no_risk_and_no_step(api: TestClient, db: Session) -> None:
    db.add(ClientContact(client_id=QUIET_ID, name="Пётр", phone="+7 900 000-00-00"))
    db.commit()

    quiet = _signals(api)[QUIET_ID]
    assert quiet["risk"] is None, "Клиент без задач не должен выглядеть проблемным"
    assert quiet["next_step"] is None


def test_overdue_beats_upcoming(api: TestClient, db: Session) -> None:
    _task(db, OVERDUE_ID, "Отправить счёт", due=NOW - timedelta(days=5))
    _task(db, OVERDUE_ID, "Позвонить завтра", due=NOW + timedelta(days=1))
    db.add(ClientContact(client_id=OVERDUE_ID, name="Анна", phone="+7 900 111-11-11"))
    db.commit()

    overdue = _signals(api)[OVERDUE_ID]
    assert overdue["next_step"]["kind"] == "overdue"
    assert overdue["next_step"]["title"] == "Отправить счёт"
    assert overdue["risk"]["level"] == "critical", "5 дней просрочки — уже не мелочь"
    assert "Просрочено" in overdue["risk"]["reason"]
    assert "5 дней" in overdue["risk"]["reason"], "Причина должна быть конкретной"


def test_short_overdue_is_warning(api: TestClient, db: Session) -> None:
    _task(db, OVERDUE_ID, "Позвонить", due=NOW - timedelta(days=1))
    db.add(ClientContact(client_id=OVERDUE_ID, name="Анна", phone="+7 900 111-11-11"))
    db.commit()

    risk = _signals(api)[OVERDUE_ID]["risk"]
    assert risk["level"] == "warning"


def test_stale_waiting_is_risk_but_fresh_is_not(api: TestClient, db: Session) -> None:
    _task(db, WAITING_ID, "Ждём реквизиты", due=NOW - timedelta(days=20), kind="waiting")
    db.add(ClientContact(client_id=WAITING_ID, name="Игорь", phone="+7 900 222-22-22"))
    db.commit()

    waiting = _signals(api)[WAITING_ID]
    assert waiting["next_step"]["kind"] == "waiting"
    assert waiting["risk"] is not None
    assert "Ждём клиента" in waiting["risk"]["reason"]
    assert "20 дней" in waiting["risk"]["reason"]


def test_fresh_waiting_has_step_but_no_risk(api: TestClient, db: Session) -> None:
    _task(db, WAITING_ID, "Ждём ответ", due=NOW - timedelta(days=2), kind="waiting")
    db.add(ClientContact(client_id=WAITING_ID, name="Игорь", phone="+7 900 222-22-22"))
    db.commit()

    waiting = _signals(api)[WAITING_ID]
    assert waiting["next_step"]["title"] == "Ждём ответ"
    assert waiting["risk"] is None, "Два дня ожидания — это нормально"


def test_overdue_invoice_outweighs_task_risk(api: TestClient, db: Session) -> None:
    _task(db, PAID_ID, "Позвонить", due=NOW - timedelta(days=1))
    db.add(ClientContact(client_id=PAID_ID, name="Олег", phone="+7 900 333-33-33"))
    db.add(
        Invoice(
            client_id=PAID_ID,
            amount=250000,
            status="issued",
            due_date=TODAY - timedelta(days=10),
        )
    )
    db.commit()

    risk = _signals(api)[PAID_ID]["risk"]
    assert "Просрочена оплата" in risk["reason"]
    assert "250 000 ₽" in risk["reason"]
    assert risk["level"] == "critical"


def test_draft_invoice_is_not_risk(api: TestClient, db: Session) -> None:
    db.add(ClientContact(client_id=PAID_ID, name="Олег", phone="+7 900 333-33-33"))
    db.add(
        Invoice(
            client_id=PAID_ID,
            amount=250000,
            status="draft",
            due_date=TODAY - timedelta(days=10),
        )
    )
    db.commit()

    assert _signals(api)[PAID_ID]["risk"] is None, "Черновик счёта ещё не отправляли"


def test_client_without_contacts_is_flagged(api: TestClient, db: Session) -> None:
    risk = _signals(api)[NOCONTACT_ID]["risk"]
    assert risk is not None
    assert "Нет контактов" in risk["reason"]


def test_signals_do_not_break_search(api: TestClient, db: Session) -> None:
    """Поиск идёт другим путём — подсказки должны работать и там."""
    _task(db, OVERDUE_ID, "Позвонить", due=NOW - timedelta(days=4))
    db.add(ClientContact(client_id=OVERDUE_ID, name="Анна", phone="+7 900 111-11-11"))
    db.commit()

    response = api.get("/api/v1/clients", params={"q": "просроченный"})
    assert response.status_code == 200
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["next_step"]["title"] == "Позвонить"
    assert items[0]["risk"]["level"] == "critical"
