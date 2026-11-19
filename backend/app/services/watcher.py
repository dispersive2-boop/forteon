"""Наблюдатель за новыми заметками: опрос раз в N секунд.

Логика:
* берёт заметки в статусе `pending` / `failed` с числом попыток < лимита;
* для каждой запускает AI-извлечение (RouterAI / локальный fallback);
* статус: `pending` → `queued` → `ok` | `failed`;
* повторные попытки не создают дублей благодаря `dedupe_key`.

Запускается фоновой задачей FastAPI (lifespan) либо Celery beat в production.
"""
from __future__ import annotations

import logging
import threading
import time

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import AIRun, Note, User
from .extraction import run_extraction

log = logging.getLogger("forteon.watcher")

MAX_ATTEMPTS = 3


def process_pending_notes(db: Session, limit: int | None = None) -> int:
    """Обработать очередь заметок. Возвращает количество обработанных."""
    limit = limit or settings.note_watcher_batch

    pending = list(
        db.scalars(
            select(Note)
            .where(
                Note.deleted_at.is_(None),
                Note.ai_status.in_(("pending", "failed", "queued")),
            )
            .order_by(Note.created_at)
            .limit(limit)
        )
    )
    if not pending:
        return 0

    processed = 0
    for note in pending:
        attempts = db.query(AIRun).filter(AIRun.note_id == note.id).count()
        if attempts >= MAX_ATTEMPTS:
            note.ai_status = "failed"
            note.ai_error = f"Превышено число попыток ({MAX_ATTEMPTS})"
            continue

        author = db.get(User, note.author_id)
        if author is None:
            note.ai_status = "failed"
            note.ai_error = "Автор заметки не найден"
            continue

        try:
            note.ai_status = "queued"
            db.commit()

            result = run_extraction(db, note, author)
            db.commit()
            processed += 1
            log.info(
                "watcher: заметка %s обработана (задач=%s, модель=%s)",
                note.id[:8], len(result.tasks), result.model,
            )
        except Exception as exc:  # заметка не теряется
            db.rollback()
            fresh = db.get(Note, note.id)
            if fresh is not None:
                fresh.ai_status = "failed"
                fresh.ai_error = f"{type(exc).__name__}: {exc}"
                db.commit()
            log.warning("watcher: ошибка заметки %s — %s", note.id[:8], exc)

    return processed


class NoteWatcher:
    """Поток-демон: опрос очереди заметок каждые N секунд."""

    def __init__(self, interval_seconds: int | None = None) -> None:
        self.interval = interval_seconds or settings.note_watcher_interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="forteon-note-watcher", daemon=True)
        self._thread.start()
        log.info("watcher: запущен, интервал %s c", self.interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        log.info("watcher: остановлен")

    def _run(self) -> None:
        # Первый проход — почти сразу (5 с), чтобы подхватить «зависшие» заметки
        first = True
        while not self._stop.is_set():
            db = SessionLocal()
            try:
                count = process_pending_notes(db)
                if count:
                    log.info("watcher: обработано заметок — %s", count)
            except Exception as exc:
                log.warning("watcher: цикл упал — %s: %s", type(exc).__name__, exc)
            finally:
                db.close()

            self._stop.wait(5 if first else self.interval)
            first = False


watcher = NoteWatcher()
