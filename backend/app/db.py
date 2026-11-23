"""Подключение к БД и базовый declarative-класс."""
from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from .config import settings

log = logging.getLogger("forteon.db")

_connect_args: dict = {}
if settings.database_url.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}

engine = create_engine(
    settings.database_url,
    echo=settings.sql_echo,
    pool_pre_ping=True,
    connect_args=_connect_args,
)

if settings.database_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):  # pragma: no cover - infra
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        # busy_timeout: в WAL пишет только один процесс за раз. Без таймаута
        # SQLite сразу отдаёт «database is locked», и фоновая задача разбора
        # заметки падала при попытке записать ai_status, пока запрос создания
        # заметки ещё держал транзакцию. Снаружи это выглядело как «разбор
        # не удался», хотя задачи уже были созданы. 15 с — с запасом.
        cursor.execute("PRAGMA busy_timeout=15000")
        cursor.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base = declarative_base()


def get_db() -> Iterator[Session]:
    """FastAPI-зависимость: сессия на запрос."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Контекст для фоновых задач и скриптов."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db() -> None:
    """Создаёт схему. Для production — миграции Alembic."""
    from . import models  # noqa: F401  (регистрация метаданных)

    Base.metadata.create_all(bind=engine)
    _add_missing_columns()


# Новые поля, появившиеся после первого развёртывания.
# create_all() не меняет существующие таблицы, поэтому колонки добавляем сами:
# для SQLite это безопасно (ADD COLUMN с NOT NULL требует DEFAULT).
_ADDED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "tasks": [
        ("review_question", "TEXT"),
        ("event_kind", "VARCHAR(16) DEFAULT 'todo' NOT NULL"),
        ("actor", "VARCHAR(16) DEFAULT 'us' NOT NULL"),
    ],
    # п.23 «30 идей»: время утреннего дайджеста у пользователя.
    "users": [
        ("digest_time", "VARCHAR(5) DEFAULT '09:00'"),
    ],
    # п.15 «30 идей»: договор связан со счётом.
    # ALTER TABLE ... ADD COLUMN с NULL безопасен для существующих строк.
    "contracts": [
        ("invoice_id", "VARCHAR(36)"),
    ],
}


def _add_missing_columns() -> None:
    """Досоздаёт недостающие колонки в существующих таблицах.

    Полноценные миграции (Alembic) для проекта избыточны: схема живёт на
    SQLite, изменения аддитивные. Здесь ровно один сценарий — «колонки нет,
    добавь». Если таблицы нет вовсе, create_all() её уже создал с полным
    набором полей, и цикл ничего не найдёт.
    """
    if not settings.database_url.startswith("sqlite"):
        return

    with engine.begin() as conn:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {
                row[1]
                for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")
            }
            if not existing:
                continue
            for name, ddl in columns:
                if name in existing:
                    continue
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
                log.info("БД: добавлена колонка %s.%s", table, name)


log = logging.getLogger("forteon.db")
