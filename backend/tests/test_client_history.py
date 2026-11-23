"""п.21 «30 идей»: история клиента одной лентой.

Почему именно так
-----------------
Лента истории уже собиралась из журнала аудита, но смотрела только на
счета, оплаты, задачи и проекты. Договоры и документы писали события в
аудит — и они туда не попадали, то есть на деле «одной лентой» история
не была: менеджер не видел, что договор завели или прикрепили скан.

Проверяем поведение:
  * событие договора попадает в историю клиента;
  * событие документа тоже;
  * события чужого клиента не подмешиваются;
  * лента идёт от новых к старым.
"""
from __future__ import annotations

import json
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
from app.models import AuditLog, Client, Contract, Document, User  # noqa: E402
from app.security import hash_password  # noqa: E402

USER_ID = "hist-user-0000-0000-0000-00000000001"
OTHER_ID = "hist-user-0000-0000-0000-00000000002"
CLIENT_ID = "hist-client-0000-0000-0000-00000001"
FOREIGN_ID = "hist-client-0000-0000-0000-00000002"
CONTRACT_ID = "hist-contract-0000-0000-0000-000001"
DOCUMENT_ID = "hist-document-0000-0000-0000-000001"
FOREIGN_CONTRACT_ID = "hist-contract-0000-0000-0000-000002"


def _log(entry_id: str, entity: str, entity_id: str, action: str,
         actor_id: str, minutes: int) -> AuditLog:
    return AuditLog(
        id=entry_id,
        entity=entity,
        entity_id=entity_id,
        action=action,
        actor_id=actor_id,
        metadata_json=json.dumps({"number": "17/2026"}),
        created_at=datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=minutes),
    )


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()

    # Пользователи отдельным коммитом: у Client.owner_id нет relationship.
    session.add_all([
        User(id=USER_ID, email="hist@forteon.local", full_name="Менеджер Ленты",
             password_hash=hash_password("Hist-pass-123"), role="manager", is_active=True),
        User(id=OTHER_ID, email="other-hist@forteon.local", full_name="Чужой Менеджер",
             password_hash=hash_password("Hist-pass-456"), role="manager", is_active=True),
    ])
    session.commit()

    session.add_all([
        Client(id=CLIENT_ID, name="Клиент ленты", owner_id=USER_ID, status="active"),
        Client(id=FOREIGN_ID, name="Чужой клиент", owner_id=OTHER_ID, status="active"),
    ])
    session.commit()

    session.add_all([
        Contract(id=CONTRACT_ID, client_id=CLIENT_ID, number="17/2026"),
        Contract(id=FOREIGN_CONTRACT_ID, client_id=FOREIGN_ID, number="99/2026"),
        Document(id=DOCUMENT_ID, client_id=CLIENT_ID, filename="scan.pdf",
                 storage_key="scan.pdf", mime_type="application/pdf", size=100),
    ])
    session.commit()

    session.add_all([
        _log("hist-log-1", "contract", CONTRACT_ID, "created", USER_ID, minutes=30),
        _log("hist-log-2", "document", DOCUMENT_ID, "uploaded", USER_ID, minutes=20),
        _log("hist-log-3", "contract", FOREIGN_CONTRACT_ID, "created", OTHER_ID, minutes=10),
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


def test_history_includes_contract_and_document(api: TestClient) -> None:
    response = api.get(f"/api/v1/clients/{CLIENT_ID}/history")
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    entities = {item["entity"] for item in items}
    assert "contract" in entities, "Договор должен быть в ленте клиента"
    assert "document" in entities, "Документ должен быть в ленте клиента"


def test_history_excludes_foreign_client(api: TestClient) -> None:
    items = api.get(f"/api/v1/clients/{CLIENT_ID}/history").json()["items"]
    assert FOREIGN_CONTRACT_ID not in {item["entity_id"] for item in items}, (
        "Событие чужого клиента попало в ленту"
    )


def test_history_newest_first(api: TestClient) -> None:
    items = api.get(f"/api/v1/clients/{CLIENT_ID}/history").json()["items"]
    assert len(items) >= 2
    # Документ заведён позже договора (минус 20 против минус 30), значит выше.
    assert items[0]["entity"] == "document"
    assert items[1]["entity"] == "contract"


def test_history_has_actor_name(api: TestClient) -> None:
    items = api.get(f"/api/v1/clients/{CLIENT_ID}/history").json()["items"]
    assert all(item["actor"] == "Менеджер Ленты" for item in items)
