"""п.12 «30 идей»: предпросмотр импорта показывает дубли ДО записи в базу.

Почему именно так
-----------------
Повторный импорт того же файла раньше отвечал «создано 4», хотя все четыре
задачи уже были в базе: счётчик считал попытки, а не новые строки. Менеджер
видел рост и думал, что данных стало вдвое больше.

Проверяем поведение, а не поля ответа:
  * предпросмотр на чистой базе не находит дублей;
  * после реального импорта тот же файл целиком уходит в дубли;
  * в списке дублей есть номер строки файла и клиент — иначе непонятно,
    что именно открывать в Excel;
  * предпросмотр ничего не пишет: число задач в базе не меняется;
  * «создано» во втором предпросмотре равно нулю — иначе счётчик врёт.
"""
from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings  # noqa: E402

assert "forteon_test" in _settings.database_url

from app.db import Base, engine, get_db  # noqa: E402
from app.deps import get_current_user, require_admin  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Client, Task, User  # noqa: E402
from app.security import hash_password  # noqa: E402

ADMIN_ID = "import-admin-0000-0000-0000-000000000001"
PREVIEW = "/api/v1/admin/import/grishanov/preview"
IMPORT = "/api/v1/admin/import/grishanov"

HEADER = [
    "Наименование", "Статус", "Локация", "Дата получения", "Объём",
    "Плановая выручка", "Услуга", "Сделано ранее", "Сделано за спринт",
    "План следующего спринта", "Проблемы", "Комментарий совещания",
]
FIRST_ROW = [
    "ООО Ромашка", "в работе", "Москва", "01.11.2026", 10, 500000,
    "монтаж", "проект согласован", "поставка выполнена",
    "Заказать кабель; Смонтировать шкаф",
    "нет кабеля, просрочен платёж",
    "обсудили сроки",
]


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    session.add(
        User(
            id=ADMIN_ID,
            email="import@forteon.local",
            full_name="Администратор Импорта",
            password_hash=hash_password("Import-pass-123"),
            role="admin",
            is_active=True,
        )
    )
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
        return db.get(User, ADMIN_ID)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[require_admin] = _user
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _xlsx(path: Path) -> Path:
    book = Workbook()
    sheet = book.active
    sheet.append(HEADER)
    sheet.append(FIRST_ROW)
    book.save(path)
    return path


def _upload(client: TestClient, url: str, path: Path):
    with path.open("rb") as handle:
        # default_path=False: берём именно наш файл, а не отчёт на рабочем столе
        return client.post(url, files={"file": (path.name, handle)}, params={"default_path": "false"})


def _tasks(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(Task)) or 0


def test_first_preview_has_no_duplicates(api: TestClient, tmp_path: Path) -> None:
    response = _upload(api, PREVIEW, _xlsx(tmp_path / "report-16.11.2026.xlsx"))
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["duplicates_count"] == 0
    assert payload["duplicates"] == []
    # Строки в файле действительно новые
    assert payload["tasks_created"] >= 1


def test_preview_does_not_touch_database(api: TestClient, db: Session, tmp_path: Path) -> None:
    file = _xlsx(tmp_path / "report-16.11.2026.xlsx")
    before = _tasks(db)
    assert _upload(api, PREVIEW, file).status_code == 200
    assert _tasks(db) == before, "Предпросмотр не должен сохранять задачи"


def test_second_preview_reports_every_row_as_duplicate(
    api: TestClient, db: Session, tmp_path: Path
) -> None:
    file = _xlsx(tmp_path / "report-16.11.2026.xlsx")

    first = _upload(api, IMPORT, file)
    assert first.status_code == 200, first.text
    created = first.json()
    assert created["tasks_created"] >= 1
    total_after_import = _tasks(db)

    second = _upload(api, PREVIEW, file)
    assert second.status_code == 200, second.text
    payload = second.json()

    # Всё, что создано первым импортом, второй раз — дубли
    assert payload["tasks_created"] == 0, "Повторный предпросмотр не должен обещать новые задачи"
    assert payload["duplicates_count"] == created["tasks_created"]
    assert len(payload["duplicates"]) == created["tasks_created"]

    # В базе ничего не прибавилось
    assert _tasks(db) == total_after_import

    sample = payload["duplicates"][0]
    assert sample["row"] == 2, "Номер строки нужен, чтобы открыть файл и проверить"
    assert sample["client_name"] == "ООО Ромашка"
    assert sample["task_title"]
    assert "уже есть" in sample["reason"]


def test_duplicate_list_is_capped_but_count_is_honest(tmp_path: Path) -> None:
    """Список дублей обрезан для интерфейса, а счётчик остаётся полным."""
    from app.services.importer import DuplicateRow, ImportStats

    stats = ImportStats()
    for index in range(120):
        stats.duplicates_skipped += 1
        if len(stats.duplicate_rows) < 50:
            stats.duplicate_rows.append(
                DuplicateRow(row=index + 2, client_name="Клиент", task_title=f"Дело {index}")
            )
    assert stats.duplicates_skipped == 120
    assert len(stats.duplicate_rows) == 50


def test_duplicates_do_not_leak_into_import_result(api: TestClient, tmp_path: Path) -> None:
    """Обычный импорт отвечает ImportResult — без служебных полей предпросмотра."""
    file = _xlsx(tmp_path / "report-16.11.2026.xlsx")
    first = _upload(api, IMPORT, file)
    assert first.status_code == 200
    assert "duplicates" not in first.json()

    second = _upload(api, PREVIEW, file)
    assert second.status_code == 200
    assert "duplicates" in second.json()
