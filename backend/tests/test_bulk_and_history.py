"""v1.2: массовые действия, история задачи, уведомления.

Проверяем поведение, а не «эндпоинт отвечает»:
  * bulk complete закрывает только свои открытые задачи;
  * чужая задача пропускается, а не 404;
  * reschedule без даты — 422;
  * история задачи отдаёт audit_log с именем актёра;
  * unread-count и read-all работают как счётчик, а не как украшение.
"""
from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings  # noqa: E402

assert "forteon_test" in _settings.database_url

from app.db import Base, engine, get_db  # noqa: E402
from app.deps import get_current_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Client, Notification, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402

USER_ID = "bulk-user-0000-0000-0000-000000000001"
OTHER_ID = "bulk-user-0000-0000-0000-000000000002"
CLIENT_ID = "bulk-client-0000-0000-0000-000000000001"


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    user = User(
        id=USER_ID,
        email="bulk@forteon.local",
        full_name="Менеджер Масс",
        password_hash=hash_password("Bulk-pass-123"),
        role="manager",
        is_active=True,
    )
    other = User(
        id=OTHER_ID,
        email="other@forteon.local",
        full_name="Чужой Менеджер",
        password_hash=hash_password("Other-pass-123"),
        role="manager",
        is_active=True,
    )
    client = Client(id=CLIENT_ID, name="Массовый клиент", owner_id=USER_ID, status="active")
    session.add_all([user, other, client])
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


def _make_task(db: Session, title: str, owner_id: str = USER_ID, client_id: str = CLIENT_ID) -> Task:
    task = Task(
        client_id=client_id,
        assignee_id=owner_id,
        title=title,
        type="call",
        priority="normal",
        status="open",
        origin="manual",
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def test_bulk_complete_and_skip_foreign(api: TestClient, db: Session) -> None:
    own = _make_task(db, "Своя задача")
    foreign_client = Client(
        id="bulk-client-0000-0000-0000-000000000002",
        name="Чужой клиент",
        owner_id=OTHER_ID,
        status="active",
    )
    db.add(foreign_client)
    db.commit()
    alien = _make_task(
        db,
        "Чужая задача",
        owner_id=OTHER_ID,
        client_id=foreign_client.id,
    )

    resp = api.post(
        "/api/v1/tasks/bulk",
        json={"ids": [own.id, alien.id], "action": "complete"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["done"] == 1
    assert data["skipped"] == 1
    db.expire_all()
    assert db.get(Task, own.id).status == "done"
    assert db.get(Task, alien.id).status == "open"


def test_bulk_reschedule_requires_date(api: TestClient) -> None:
    resp = api.post(
        "/api/v1/tasks/bulk",
        json={"ids": ["any"], "action": "reschedule"},
    )
    assert resp.status_code == 422


def test_task_history_from_audit(api: TestClient, db: Session) -> None:
    task = _make_task(db, "История")
    api.post(f"/api/v1/tasks/{task.id}/complete", json={"result_note": None})
    api.post(f"/api/v1/tasks/{task.id}/reopen")

    resp = api.get(f"/api/v1/tasks/{task.id}/history")
    assert resp.status_code == 200, resp.text
    actions = [i["action"] for i in resp.json()["items"]]
    assert "completed" in actions
    assert "reopened" in actions
    assert all(i["actor"] == "Менеджер Масс" for i in resp.json()["items"])


def test_notifications_unread_and_read_all(api: TestClient, db: Session) -> None:
    db.add_all(
        [
            Notification(user_id=USER_ID, title="Просрочка 1", status="pending"),
            Notification(user_id=USER_ID, title="Просрочка 2", status="pending"),
        ]
    )
    db.commit()

    first = api.get("/api/v1/notifications/unread-count").json()
    assert first["count"] == 2

    read_one = api.get("/api/v1/notifications").json()[0]
    resp = api.post(f"/api/v1/notifications/{read_one['id']}/read")
    assert resp.status_code == 204

    assert api.get("/api/v1/notifications/unread-count").json()["count"] == 1

    api.post("/api/v1/notifications/read-all")
    assert api.get("/api/v1/notifications/unread-count").json()["count"] == 0
