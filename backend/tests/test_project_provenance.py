"""п.14 «30 идей»: откуда взялось важное поле проекта.

Почему именно так
-----------------
Менеджер спрашивает не «кто менял запись», а «откуда эта сумма». Поэтому
эндпоинт отвечает на его вопрос: строка файла импорта, кто завёл проект,
каждое изменение денег с прежним и новым значением.

Проверяем поведение:
  * проект из импорта помнит строку файла, проект «из системы» — нет;
  * создание попадает в историю с автором;
  * изменение суммы даёт отдельную строку «было → стало», а не «поля: [...]»;
  * изменение неденежного поля не выдаёт себя за изменение суммы.
"""
from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings

assert "forteon_test" in _settings.database_url

from app.db import Base, engine, get_db  # noqa: E402
from app.deps import get_current_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Client, Project, User  # noqa: E402
from app.security import hash_password  # noqa: E402

USER_ID = "provenance-user-0000-0000-0000-000000000001"
CLIENT_ID = "provenance-client-0000-0000-0000-000000000001"
PROJECT_ID = "provenance-project-0000-0000-0000-00000000001"


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    session.add_all([
        User(
            id=USER_ID,
            email="prov@forteon.local",
            full_name="Менеджер Проверки",
            password_hash=hash_password("Prov-pass-123"),
            role="manager",
            is_active=True,
        ),
        Client(id=CLIENT_ID, name="Клиент Проверки", owner_id=USER_ID, status="active"),
    ])
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


def _new_project(api: TestClient, **extra) -> dict:
    payload = {"name": "Шкаф управления", **extra}
    response = api.post(f"/api/v1/clients/{CLIENT_ID}/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def test_manual_project_has_no_source_row(api: TestClient) -> None:
    project = _new_project(api)
    provenance = api.get(f"/api/v1/projects/{project['id']}/provenance")
    assert provenance.status_code == 200, provenance.text
    data = provenance.json()
    assert data["source_row"] is None
    assert data["origin"] == "manual"
    assert data["created_by"] == "Менеджер Проверки"
    assert any(entry["action"] == "created" for entry in data["entries"])


def test_imported_project_remembers_file_row(api: TestClient, db: Session) -> None:
    project = _new_project(api)
    row = db.get(Project, project["id"])
    row.source_row = 47
    db.commit()

    data = api.get(f"/api/v1/projects/{project['id']}/provenance").json()
    assert data["source_row"] == 47
    assert data["origin"] == "import"


def test_money_change_shows_before_and_after(api: TestClient) -> None:
    project = _new_project(api, planned_revenue=500000, estimated_cost=300000)

    patched = api.patch(
        f"/api/v1/projects/{project['id']}",
        json={"planned_revenue": 620000, "version": project["version"]},
    )
    assert patched.status_code == 200, patched.text

    entries = api.get(f"/api/v1/projects/{project['id']}/provenance").json()["entries"]
    money = [entry for entry in entries if entry["action"] == "money"]
    assert len(money) == 1
    assert money[0]["detail"] == "Плановая выручка изменена"
    assert money[0]["before"] == "500000.00"
    assert money[0]["after"] == "620000.00"
    assert money[0]["actor"] == "Менеджер Проверки"


def test_non_money_change_does_not_look_like_money(api: TestClient) -> None:
    project = _new_project(api, planned_revenue=100000)

    patched = api.patch(
        f"/api/v1/projects/{project['id']}",
        json={"location": "Казань", "version": project["version"]},
    )
    assert patched.status_code == 200, patched.text

    entries = api.get(f"/api/v1/projects/{project['id']}/provenance").json()["entries"]
    assert not [entry for entry in entries if entry["action"] == "money"]
    updated = [entry for entry in entries if entry["action"] == "updated"]
    assert updated and "location" in updated[0]["detail"]


def test_provenance_requires_access(api: TestClient, db: Session) -> None:
    project = _new_project(api)
    other = User(
        id="provenance-stranger-0000-0000-00000000001",
        email="stranger@forteon.local",
        full_name="Посторонний",
        password_hash=hash_password("Stranger-pass-1"),
        role="manager",
        is_active=True,
    )
    db.add(other)
    db.commit()

    app.dependency_overrides[get_current_user] = lambda: other
    response = api.get(f"/api/v1/projects/{project['id']}/provenance")
    assert response.status_code == 404, "Чужой клиент не должен раскрывать даже факт существования"
