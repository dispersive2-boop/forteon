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
from datetime import datetime, timedelta, timezone
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings  # noqa: E402

assert "forteon_test" in _settings.database_url

from app.db import Base, engine, get_db  # noqa: E402
from app.deps import get_current_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Client, ClientContact, Notification, Project, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.services.reports import _fmt_money, build_pdf, build_xlsx  # noqa: E402

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


def test_create_manual_task_validates_title_and_project(api: TestClient, db: Session) -> None:
    other_client = Client(name="Другой клиент", owner_id=USER_ID)
    db.add(other_client)
    db.flush()
    project = Project(name="Свой проект", client_id=CLIENT_ID)
    other_project = Project(name="Чужой проект", client_id=other_client.id)
    db.add_all([project, other_project])
    db.commit()

    body = {"client_id": CLIENT_ID, "title": "  Открыть проект  ", "project_id": project.id}
    assert api.post("/api/v1/tasks", json={**body, "title": "   "}).status_code == 422
    assert api.post("/api/v1/tasks", json={**body, "project_id": other_project.id}).status_code == 422

    response = api.post("/api/v1/tasks", json=body)
    assert response.status_code == 201, response.text
    task = response.json()
    assert task["title"] == "Открыть проект"
    assert task["project_id"] == project.id
    assert task["due_date"] is None
    assert task["needs_review"] is False
    assert api.get(f"/api/v1/tasks/{task['id']}").json()["origin"] == "manual"


def test_expected_profit_requires_cost_and_stays_numeric_in_excel(api: TestClient, db: Session) -> None:
    project = Project(name="Проект с расчётом", client_id=CLIENT_ID, planned_revenue=1500000.50, estimated_cost=250000)
    incomplete = Project(name="Проект без затрат", client_id=CLIENT_ID, planned_revenue=200000)
    db.add_all([project, incomplete])
    db.commit()

    response = api.get(f"/api/v1/clients/{CLIENT_ID}/projects")
    assert response.status_code == 200
    by_id = {item["id"]: item for item in response.json()}
    assert by_id[project.id]["expected_profit"] == 1250000.50
    assert by_id[incomplete.id]["expected_profit"] is None

    rows = [{
        "client": db.get(Client, CLIENT_ID),
        "projects": [project, incomplete],
        "tasks": [], "open_tasks": [], "overdue": [], "done": [],
        "billed": 0, "debt": 0,
    }]
    workbook = load_workbook(BytesIO(build_xlsx(db, rows, "Все даты", ["projects"])))
    sheet = workbook["Проекты"]
    assert sheet["H1"].value == "Ожидаемая прибыль, ₽"
    assert sheet["H2"].value == 1250000.50
    assert sheet["H2"].number_format == '#,##0.00" ₽"'
    assert sheet["H3"].value is None
    assert _fmt_money(project.expected_profit) == "1\u00a0250\u00a0000,50\u00a0₽"
    assert build_pdf(db, rows, "Все даты", "Тест", ["projects"]).startswith(b"%PDF")



def test_snooze_does_not_get_marked_as_read(api: TestClient, db: Session) -> None:
    own = Notification(user_id=USER_ID, title="Позвонить", status="pending")
    other = Notification(user_id=OTHER_ID, title="Чужое", status="pending")
    db.add_all([own, other])
    db.commit()
    until = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert api.post(f"/api/v1/notifications/{other.id}/snooze", json={"until": until}).status_code == 404
    assert api.post(f"/api/v1/notifications/{own.id}/snooze", json={"until": until}).status_code == 204
    assert api.get("/api/v1/notifications").json() == []
    assert api.get("/api/v1/notifications/unread-count").json()["count"] == 0
    assert api.post("/api/v1/notifications/read-all").json()["read"] == 0
    own.scheduled_at -= timedelta(hours=2)
    db.commit()
    assert api.get("/api/v1/notifications/unread-count").json()["count"] == 1


def test_workspace_search_links_and_respects_scope(api: TestClient, db: Session) -> None:
    hidden = Client(name="Чужой объект", owner_id=OTHER_ID)
    db.add(hidden)
    db.flush()
    own = ClientContact(client_id=CLIENT_ID, name="Алексей", phone="+7 (999) 123-45-67")
    db.add_all([
        own, ClientContact(client_id=hidden.id, name="Чужой контакт", phone="79991234567"),
        Project(client_id=CLIENT_ID, name="Семёновский проект"),
    ])
    db.commit()
    phone = api.get("/api/v1/workspace-search", params={"q": "999123"}).json()["items"]
    assert len(phone) == 1
    assert phone[0]["matched_field"] == "Телефон"
    assert phone[0]["href"].endswith(f"?tab=overview#contact-{own.id}")
    project = api.get("/api/v1/workspace-search", params={"q": "семеновский"}).json()["items"]
    assert project[0]["matched_field"] == "Проект"


def test_import_preview_does_not_save_records(api: TestClient, db: Session) -> None:
    user = db.get(User, USER_ID)
    user.role = "admin"
    db.commit()
    workbook = Workbook()
    workbook.active.append(["Наименование", "Статус", "Место", "Дата", "Объём", "Выручка"])
    workbook.active.append(["Новый объект", "active", "Уфа", None, 100, 150000])
    buf = BytesIO()
    workbook.save(buf)
    files = {"file": ("QA 16.11.2026.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    response = api.post("/api/v1/admin/import/grishanov/preview", files=files)
    assert response.status_code == 200, response.text
    assert response.json()["clients_created"] == 1
    assert response.json()["sample"][1][0] == "Новый объект"
    assert db.scalar(select(func.count()).select_from(Client)) == 1
    assert db.scalar(select(func.count()).select_from(Project)) == 0
    imported = api.post("/api/v1/admin/import/grishanov", files=files)
    assert imported.status_code == 200, imported.text
    assert db.scalar(select(func.count()).select_from(Client)) == 2


def test_revoke_other_sessions_keeps_current_device_and_cleans_active_list(db: Session) -> None:
    from app.security import create_token

    def bearer(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    with TestClient(app) as client:
        first = client.post("/api/v1/auth/login", json={
            "email": "bulk@forteon.local", "password": "Bulk-pass-123", "device_label": "Первый",
        }).json()
        second = client.post("/api/v1/auth/login", json={
            "email": "bulk@forteon.local", "password": "Bulk-pass-123", "device_label": "Второй",
        }).json()
        unrelated = client.post("/api/v1/auth/login", json={
            "email": "other@forteon.local", "password": "Other-pass-123",
        }).json()
        old_access = create_token({"sub": USER_ID}, _settings.secret_key, 3600)
        first_headers = bearer(first["access_token"])
        initial = client.get("/api/v1/auth/sessions", headers=first_headers).json()
        assert len(initial) == 2
        current_id = next(row["id"] for row in initial if row["is_current"])
        assert initial[0]["id"] != initial[1]["id"]

        rotated = client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
        assert rotated.status_code == 200, rotated.text
        assert client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]}).status_code == 401
        first = rotated.json()
        first_headers = bearer(first["access_token"])
        after_refresh = client.get("/api/v1/auth/sessions", headers=first_headers).json()
        assert len(after_refresh) == 2
        assert next(row["id"] for row in after_refresh if row["is_current"]) == current_id

        incorrect = client.post("/api/v1/auth/sessions/revoke-others", headers=bearer(old_access), json={
            "refresh_token": unrelated["refresh_token"],
        })
        assert incorrect.status_code == 409
        result = client.post("/api/v1/auth/sessions/revoke-others", headers=first_headers, json={})
        assert result.status_code == 200, result.text
        assert [row["id"] for row in result.json()] == [current_id]
        assert result.json()[0]["is_current"] is True
        assert client.get("/api/v1/auth/sessions", headers=first_headers).json() == result.json()
        assert client.get("/api/v1/auth/me", headers=first_headers).status_code == 200
        assert client.get("/api/v1/auth/me", headers=bearer(second["access_token"])).status_code == 401
        assert client.get("/api/v1/auth/me", headers=bearer(old_access)).status_code == 401
        assert client.post("/api/v1/auth/refresh", json={"refresh_token": second["refresh_token"]}).status_code == 401
        assert client.get("/api/v1/auth/me", headers=bearer(unrelated["access_token"])).status_code == 200
        assert client.post("/api/v1/auth/refresh", json={"refresh_token": first["refresh_token"]}).status_code == 200


def test_free_note_creates_personal_and_object_tasks(api: TestClient, db: Session) -> None:
    own = Project(client_id=CLIENT_ID, name="Северный терминал")
    duplicate = [
        Project(client_id=CLIENT_ID, name="Восточный объект"),
        Project(client_id=CLIENT_ID, name="Восточный объект"),
    ]
    other_client = Client(name="Чужой клиент", owner_id=OTHER_ID)
    db.add(other_client)
    db.flush()
    db.add_all([own, *duplicate, Project(client_id=other_client.id, name="Чужой терминал")])
    db.commit()

    body = {
        "body": (
            "Завтра отправить КП: Северный терминал. "
            "Напомнить про Восточный объект в пятницу. "
            "Завтра позвонить: Чужой терминал. "
            "В понедельник проверить почту."
        ),
        "source_type": "voice",
        "idempotency_key": "free-qa",
    }
    response = api.post("/api/v1/notes/free", json=body)
    assert response.status_code == 201, response.text
    note = response.json()
    tasks = api.get(f"/api/v1/notes/{note['id']}/tasks").json()
    assert len(tasks) == 4
    matched = next(task for task in tasks if task["project_id"])
    assert matched["project_id"] == own.id
    assert matched["client_id"] == CLIENT_ID
    assert all(task["client_id"] == note["client_id"] for task in tasks if not task["project_id"])
    assert note["client_id"] != CLIENT_ID

    repeated = api.post("/api/v1/notes/free", json=body)
    assert repeated.json()["id"] == note["id"]
    assert len(api.get(f"/api/v1/notes/{note['id']}/tasks").json()) == 4
    assert api.get("/api/v1/clients").json()["total"] == 1
    assert api.get("/api/v1/notes/feed").json()["items"] == []
    free_feed = api.get("/api/v1/notes/feed", params={"free": "true"}).json()["items"]
    assert len(free_feed) == 1
    assert any(task["project_name"] == own.name for task in free_feed[0]["tasks"])
    assert api.get("/api/v1/tasks", params={"status": "open"}).json()["total"] == 4
