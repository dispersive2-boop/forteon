"""п.25 «30 идей»: предлагаемый текст следующего сообщения с источником.

Почему именно так
-----------------
Подсказку легко отдать модели, но у неё есть жёсткое требование: она обязана
называть основание. «Здравствуйте, хочу уточнить» ни к чему не привязано —
менеджер не поймёт, откуда взялся текст и можно ли ему верить.

Поэтому подсказка детерминированная: строится из цитаты задачи, открытого
обязательства или последней заметки, и всегда говорит, из чего. Когда
основания нет — текст пустой, а не выдуманный.

Проверяем:
  * цитата задачи — приоритетный источник;
  * без цитаты берётся обязательство, затем заметка;
  * тип задачи меняет формулировку, но не источник;
  * пустой клиент даёт пустой текст с честной причиной;
  * эндпоинт отдаёт тот же источник, что и сервис.
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
from app.models import Client, Commitment, Note, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.services.suggest import suggest_message  # noqa: E402

USER_ID = "sug-user-0000-0000-0000-000000000001"
CLIENT_ID = "sug-client-0000-0000-0000-00000001"
TASK_ID = "sug-task-0000-0000-0000-0000000001"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    session.add(User(id=USER_ID, email="sug@forteon.local", full_name="Менеджер Подсказок",
                     password_hash=hash_password("Sug-pass-123"), role="manager", is_active=True))
    session.commit()
    session.add(Client(id=CLIENT_ID, name="Клиент подсказок", owner_id=USER_ID, status="active"))
    session.commit()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


def _task(db: Session, **kwargs) -> Task:
    task = Task(id=TASK_ID, client_id=CLIENT_ID, assignee_id=USER_ID,
                title=kwargs.pop("title", "Позвонить по КП"), status="open", **kwargs)
    db.add(task)
    db.commit()
    return task


def test_source_quote_wins(db: Session) -> None:
    task = _task(db, type="call", source_quote="«Обещал прислать КП к пятнице»")
    suggestion = suggest_message(db, task)
    assert suggestion.source_kind == "task"
    assert "КП" in suggestion.text
    assert suggestion.source_quote == "«Обещал прислать КП к пятнице»"


def test_type_changes_wording(db: Session) -> None:
    task = _task(db, type="payment", source_quote="оплата по счёту 17")
    suggestion = suggest_message(db, task)
    assert "оплату" in suggestion.text, "Тип payment должен давать формулировку про оплату"


def test_commitment_used_without_quote(db: Session) -> None:
    task = _task(db, type="document")
    db.add(Commitment(client_id=CLIENT_ID, description="Прислать акт сверки",
                      promised_by="client", status="open"))
    db.commit()
    suggestion = suggest_message(db, task)
    assert suggestion.source_kind == "commitment"
    assert "акт сверки" in suggestion.text


def test_note_used_when_nothing_else(db: Session) -> None:
    task = _task(db, type="call")
    db.add(Note(client_id=CLIENT_ID, author_id=USER_ID, body="Обсуждали смету на второй этаж",
                created_at=_now() - timedelta(hours=2)))
    db.commit()
    suggestion = suggest_message(db, task)
    assert suggestion.source_kind == "note"
    # Текст говорит о сути задачи, а основание показывается отдельно —
    # в этом и смысл пункта: менеджер видит, откуда взялась подсказка.
    assert "Позвонить по КП" in suggestion.text
    assert "смету" in (suggestion.source_quote or "")
    assert "заметка" in suggestion.source_label


def test_empty_client_is_honest(db: Session) -> None:
    task = _task(db, type="call")
    suggestion = suggest_message(db, task)
    assert suggestion.source_kind == "none"
    assert suggestion.text == "", "Без основания текст должен быть пустым"
    assert "нет основания" in suggestion.source_label


def test_endpoint_matches_service(db: Session) -> None:
    task = _task(db, type="call", source_quote="Клиент просил перезвонить в среду")

    def _db() -> Iterator[Session]:
        yield db

    def _user() -> User:
        return db.get(User, USER_ID)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    try:
        with TestClient(app) as api:
            response = api.get(f"/api/v1/tasks/{TASK_ID}/suggest")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["source_kind"] == "task"
        assert data["source_quote"] == "Клиент просил перезвонить в среду"
        assert "Позвонить по КП" in data["text"]
        assert data["source_label"], "Подсказка обязана называть основание"
    finally:
        app.dependency_overrides.clear()


def test_endpoint_404_for_foreign_task(db: Session) -> None:
    _task(db, type="call")
    other = User(id="sug-user-0000-0000-0000-000000000002", email="other-sug@forteon.local",
                 full_name="Другой", password_hash=hash_password("Sug-pass-456"),
                 role="manager", is_active=True)
    db.add(other)
    db.commit()

    def _db() -> Iterator[Session]:
        yield db

    def _user() -> User:
        return db.get(User, other.id)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    try:
        with TestClient(app) as api:
            response = api.get(f"/api/v1/tasks/{TASK_ID}/suggest")
        assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()
