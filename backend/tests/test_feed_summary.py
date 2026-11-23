"""п.2 «30 идей»: лента отдаёт готовую сводку разбора.

Проверяем поведение, а не форму ответа:
  * закрытые задачи не попадают в «задачи» — иначе «2 задачи» превратится в «3»,
    и менеджер решит, что появилось лишнее;
  * ожидания считаются отдельно, но входят в общий счёт задач;
  * заметка без задач не показывает «0 задач»;
  * сводка в ленте совпадает с /ai-status по смыслу (одинаковые числа).
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
from app.models import Client, Note, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402

USER_ID = "feed-user-0000-0000-0000-000000000001"
CLIENT_ID = "feed-client-0000-0000-0000-000000000001"


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    user = User(
        id=USER_ID,
        email="feed@forteon.local",
        full_name="Менеджер Ленты",
        password_hash=hash_password("Feed-pass-123"),
        role="manager",
        is_active=True,
    )
    client = Client(id=CLIENT_ID, name="Клиент Ленты", owner_id=USER_ID, status="active")
    session.add_all([user, client])
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


def _note(db: Session, body: str) -> Note:
    note = Note(client_id=CLIENT_ID, author_id=USER_ID, body=body, source_type="text", ai_status="done")
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


def _task(
    db: Session,
    note: Note,
    title: str,
    status: str = "open",
    event_kind: str = "todo",
    needs_review: bool = False,
) -> Task:
    task = Task(
        client_id=CLIENT_ID,
        assignee_id=USER_ID,
        source_note_id=note.id,
        title=title,
        type="call",
        priority="normal",
        status=status,
        origin="ai",
        event_kind=event_kind,
        needs_review=needs_review,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def _summary_of(api: TestClient, note_id: str) -> dict:
    res = api.get("/api/v1/notes/feed")
    assert res.status_code == 200
    for item in res.json()["items"]:
        if item["id"] == note_id:
            return item["summary"]
    raise AssertionError(f"заметка {note_id} не попала в ленту")


def test_feed_summary_ignores_done_tasks(api: TestClient, db: Session) -> None:
    """Закрытая задача не должна считаться активной работой."""
    note = _note(db, "Позвонить, отправить смету. Смету уже отправил.")
    _task(db, note, "Позвонить клиенту")
    _task(db, note, "Отправить смету", status="done")

    summary = _summary_of(api, note.id)
    assert summary["tasks"] == 1
    assert summary["completed"] == 1
    assert summary["headline"] == "1 задача · 1 выполнено"
    assert summary["has_details"] is True


def test_feed_summary_counts_waiting_separately(api: TestClient, db: Session) -> None:
    """Ожидание — тоже задача, но в строке показывается отдельно."""
    note = _note(db, "Клиент обещал прислать документы, а мы готовим КП.")
    _task(db, note, "Подготовить КП")
    _task(db, note, "Ждём документы от клиента", event_kind="waiting")

    summary = _summary_of(api, note.id)
    assert summary["tasks"] == 1
    assert summary["waiting"] == 1
    assert summary["headline"] == "1 задача · 1 ожидание"


def test_feed_summary_counts_questions(api: TestClient, db: Session) -> None:
    """Неоднозначная задача — это вопрос менеджеру, он виден в строке."""
    note = _note(db, "Надо что-то сделать с оплатой, но непонятно к какому счёту.")
    _task(db, note, "Разобраться с оплатой", needs_review=True)

    summary = _summary_of(api, note.id)
    assert summary["questions"] == 1
    assert summary["headline"] == "1 задача · 1 вопрос"


def test_feed_summary_empty_note_has_no_headline(api: TestClient, db: Session) -> None:
    """Пустой разбор — не повод писать «0 задач»: показывать нечего."""
    note = _note(db, "Просто созвонились, ничего не решали.")

    summary = _summary_of(api, note.id)
    assert summary["headline"] == ""
    assert summary["has_details"] is False


def test_feed_summary_matches_ai_status(api: TestClient, db: Session) -> None:
    """Числа в ленте и в /ai-status не должны разъезжаться."""
    note = _note(db, "Две задачи и одно ожидание.")
    _task(db, note, "Задача первая")
    _task(db, note, "Задача вторая")
    _task(db, note, "Ждём ответ", event_kind="waiting")

    feed = _summary_of(api, note.id)
    status = api.get(f"/api/v1/notes/{note.id}/ai-status")
    assert status.status_code == 200
    card = status.json()["summary"]
    assert (feed["tasks"], feed["waiting"]) == (card["tasks"], card["waiting"])
    assert feed["headline"] == card["headline"]
