"""Celery-приложение для фоновых задач ForteOn (AI, напоминания, отчёты).

В MVP AI-извлечение выполняется через FastAPI BackgroundTasks; worker нужен для
production-развёртывания и вынесения длительных операций из web-процесса.
"""
from __future__ import annotations

import os

try:
    from celery import Celery
except ImportError:  # локальная разработка без Celery
    Celery = None  # type: ignore[assignment]

BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
BACKEND_URL = os.getenv("CELERY_RESULT_BACKEND", BROKER_URL)

if Celery is not None:
    celery_app = Celery("forteon", broker=BROKER_URL, backend=BACKEND_URL)
    celery_app.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        timezone=os.getenv("FORTEON_TIMEZONE", "Asia/Yekaterinburg"),
        enable_utc=True,
        task_acks_late=True,
        worker_max_tasks_per_child=200,
        task_default_queue="forteon",
    )

    @celery_app.task(name="forteon.process_note", bind=True, max_retries=3, default_retry_delay=20)
    def process_note(self, note_id: str, author_id: str) -> dict:
        """AI-извлечение задач из заметки — идемпотентно по дедупликации."""
        from .db import session_scope
        from .models import Note, User
        from .services.extraction import run_extraction

        with session_scope() as db:
            note = db.get(Note, note_id)
            author = db.get(User, author_id)
            if note is None or author is None:
                return {"status": "not_found", "note_id": note_id}
            result = run_extraction(db, note, author)
            return {
                "status": "ok",
                "note_id": note_id,
                "tasks": len(result.tasks),
                "commitments": len(result.commitments),
                "model": result.model,
            }

    @celery_app.task(name="forteon.build_report")
    def build_report(report_id: str) -> dict:
        """Генерация PDF/XLSX вне web-процесса."""
        from pathlib import Path

        from .db import session_scope
        from .models import ReportJob
        from .services.reports import build_pdf, build_xlsx, collect_data, save_report

        with session_scope() as db:
            job = db.get(ReportJob, report_id)
            if job is None:
                return {"status": "not_found"}
            rows = collect_data(db, job.requested_by, True, job.client_id)
            period = "весь период"
            if job.format == "xlsx":
                content = build_xlsx(db, rows, period)
            else:
                content = build_pdf(db, rows, period, "Все клиенты")
            path = save_report(content, job.id, job.format)
            job.status = "ready"
            job.file_key = path
            job.finished_at = __import__("app.models", fromlist=["utcnow"]).utcnow()
            return {"status": "ready", "file": Path(path).name}
