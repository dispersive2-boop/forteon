"""Отчёты PDF/XLSX, дашборд и синхронизация."""
from __future__ import annotations

import json
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, get_client_or_404, get_current_user
from ..models import ChangeLog, Client, ReportJob, SyncOperation, Task, User, utcnow
from ..schemas import (
    DashboardOut,
    FinancialSummary,
    PlannerSummary,
    ReportOut,
    ReportRequest,
    SyncOperationIn,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
    SyncPushResult,
    UserOut,
)
from ..services.reports import build_pdf, build_xlsx, collect_data, save_report
from ..services.ai import make_dedupe_key

router = APIRouter(tags=["reports"])


def _period_label(date_from: date | None, date_to: date | None) -> str:
    if date_from and date_to:
        return f"{date_from.strftime('%d.%m.%Y')} — {date_to.strftime('%d.%m.%Y')}"
    if date_from:
        return f"с {date_from.strftime('%d.%m.%Y')}"
    if date_to:
        return f"по {date_to.strftime('%d.%m.%Y')}"
    return "весь период"


@router.post("/reports", response_model=ReportOut, status_code=201)
def create_report(payload: ReportRequest, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    if payload.scope == "client":
        if not payload.client_id:
            raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "Не указан client_id"})
        get_client_or_404(db, user, payload.client_id)

    job = ReportJob(
        requested_by=user.id,
        format=payload.format,
        scope=payload.scope,
        client_id=payload.client_id,
        filters_json=json.dumps(
            {
                "date_from": payload.date_from.isoformat() if payload.date_from else None,
                "date_to": payload.date_to.isoformat() if payload.date_to else None,
                "statuses": payload.statuses,
                "sections": payload.sections,
            },
            ensure_ascii=False,
        ),
        status="running",
    )
    db.add(job)
    db.commit()

    try:
        rows = collect_data(
            db, user.id, user.role == "admin", payload.client_id, payload.date_from, payload.date_to
        )
        period = _period_label(payload.date_from, payload.date_to)
        scope_label = f"Клиент: {rows[0]['client'].name}" if payload.scope == "client" and rows else "Все клиенты"
        if payload.format == "xlsx":
            content = build_xlsx(db, rows, period, payload.sections)
        else:
            content = build_pdf(db, rows, period, scope_label, payload.sections)
        path = save_report(content, job.id, payload.format)
        job.status = "ready"
        job.file_key = path
        job.finished_at = utcnow()
    except Exception as exc:
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
        job.finished_at = utcnow()

    audit(db, user, "report", job.id, "generated", {"format": payload.format, "scope": payload.scope})
    db.commit()
    db.refresh(job)
    return ReportOut.model_validate(job)


@router.get("/reports", response_model=list[ReportOut])
def list_reports(limit: int = Query(default=30, ge=1, le=200), db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    query = select(ReportJob).order_by(ReportJob.created_at.desc()).limit(limit)
    if user.role != "admin":
        query = select(ReportJob).where(ReportJob.requested_by == user.id).order_by(
            ReportJob.created_at.desc()
        ).limit(limit)
    return [ReportOut.model_validate(r) for r in db.scalars(query)]


@router.get("/reports/{report_id}", response_model=ReportOut)
def get_report(report_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    job = db.get(ReportJob, report_id)
    if job is None or (user.role != "admin" and job.requested_by != user.id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Отчёт не найден"})
    return ReportOut.model_validate(job)


@router.get("/reports/{report_id}/download")
def download_report(report_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    job = db.get(ReportJob, report_id)
    if job is None or (user.role != "admin" and job.requested_by != user.id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Отчёт не найден"})
    if job.status != "ready" or not job.file_key:
        raise HTTPException(status_code=409, detail={"code": "not_ready", "message": "Отчёт ещё не готов"})

    from pathlib import Path

    path = Path(job.file_key)
    if not path.exists():
        raise HTTPException(status_code=410, detail={"code": "gone", "message": "Файл отчёта удалён"})
    media = "application/pdf" if job.format == "pdf" else \
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return FileResponse(path, filename=path.name, media_type=media)


# ---------------------------------------------------------------- dashboard
@router.get("/dashboard", response_model=DashboardOut)
def dashboard(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    from .tasks import _planner_data, _task_out

    buckets = _planner_data(db, user)
    overdue = buckets["overdue"][:10]
    today_tasks = buckets["today"][:10]

    client_query = select(Client).where(Client.deleted_at.is_(None))
    if user.role != "admin":
        client_query = client_query.where(Client.owner_id == user.id)
    clients = list(db.scalars(client_query))

    critical: list[dict] = []
    for client in clients:
        problems = db.scalar(
            select(func.count()).select_from(Task).where(
                Task.client_id == client.id,
                Task.status == "open",
                Task.priority == "critical",
                Task.deleted_at.is_(None),
            )
        ) or 0
        if problems:
            critical.append({"client_id": client.id, "name": client.name, "critical_tasks": int(problems)})
    critical.sort(key=lambda row: row["critical_tasks"], reverse=True)

    ai_notes = db.scalar(
        select(func.count()).select_from(Task).where(
            Task.assignee_id == user.id if user.role != "admin" else True,
            Task.origin == "ai",
            Task.deleted_at.is_(None),
        )
    ) or 0

    return DashboardOut(
        user=UserOut.model_validate(user),
        summary=PlannerSummary(
            today=len(buckets["today"]),
            overdue=len(buckets["overdue"]),
            week=len(buckets["week"]),
            needs_review=len(buckets["needs_review"]),
            completed_today=0,
        ),
        financial=FinancialSummary(
            billed=0, paid=0, allocated=0, debt=0, overdue_amount=0, invoices=0, unpaid_invoices=0
        ),
        overdue=[_task_out(t) for t in overdue],
        today=[_task_out(t) for t in today_tasks],
        critical_clients=critical[:6],
        ai_health={"tasks_from_ai": int(ai_notes), "needs_review": len(buckets["needs_review"])},
    )


# ---------------------------------------------------------------- sync
def _apply_operation(db: Session, user: User, operation: SyncOperationIn) -> SyncPushResult:
    existing = db.scalar(
        select(SyncOperation).where(SyncOperation.operation_id == operation.operation_id)
    )
    if existing:
        return SyncPushResult(
            operation_id=operation.operation_id,
            status="idempotent",
            entity_id=existing.payload,
            conflict=False,
        )

    appli: SyncPushResult
    if operation.entity == "task" and operation.action == "create":
        payload = operation.payload
        client_id = payload.get("client_id")
        client = db.get(Client, client_id) if client_id else None
        if client is None or (user.role != "admin" and client.owner_id != user.id):
            return SyncPushResult(
                operation_id=operation.operation_id, status="rejected", conflict=True,
                message="Клиент недоступен",
            )
        task = Task(
            client_id=client.id,
            assignee_id=user.id,
            title=str(payload.get("title") or "Задача")[:480],
            type=str(payload.get("type") or "other"),
            priority=str(payload.get("priority") or "normal"),
            status="open",
            due_date=date.fromisoformat(payload["due_date"]) if payload.get("due_date") else None,
            origin="manual",
            timezone=user.timezone,
            dedupe_key=make_dedupe_key(client.id, str(payload.get("title") or ""), None),
        )
        db.add(task)
        db.flush()
        appli = SyncPushResult(operation_id=operation.operation_id, status="applied", entity_id=task.id)
        entity_id = task.id
    elif operation.entity == "note" and operation.action == "create":
        from ..models import Note

        payload = operation.payload
        client_id = payload.get("client_id")
        client = db.get(Client, client_id) if client_id else None
        if client is None or (user.role != "admin" and client.owner_id != user.id):
            return SyncPushResult(
                operation_id=operation.operation_id, status="rejected", conflict=True,
                message="Клиент недоступен",
            )
        note = Note(
            client_id=client.id,
            author_id=user.id,
            body=str(payload.get("body") or "")[:20000],
            source_type="text",
            ai_status="pending",
            idempotency_key=f"sync:{operation.operation_id}",
            note_timezone=user.timezone,
        )
        db.add(note)
        db.flush()
        appli = SyncPushResult(operation_id=operation.operation_id, status="applied", entity_id=note.id)
        entity_id = note.id
    else:
        appli = SyncPushResult(
            operation_id=operation.operation_id, status="unsupported", conflict=False,
            message="Операция не поддерживается в MVP",
        )
        entity_id = None

    db.add(
        SyncOperation(
            operation_id=operation.operation_id,
            user_id=user.id,
            entity=operation.entity,
            action=operation.action,
            base_version=operation.base_version,
            result=appli.status,
            payload=entity_id,
        )
    )
    return appli


@router.post("/sync/push", response_model=SyncPushResponse)
def sync_push(payload: SyncPushRequest, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    results = [_apply_operation(db, user, op) for op in payload.operations]
    db.commit()
    return SyncPushResponse(results=results, server_time=utcnow())


@router.get("/sync/pull", response_model=SyncPullResponse)
def sync_pull(since: int = 0, limit: int = Query(default=500, ge=1, le=2000),
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    query = select(ChangeLog).where(ChangeLog.sequence > since)
    if user.role != "admin":
        query = query.where(
            (ChangeLog.owner_id == user.id) | (ChangeLog.owner_id.is_(None))
        )
    rows = list(db.scalars(query.order_by(ChangeLog.sequence).limit(limit)))
    changes = [
        {
            "sequence": row.sequence,
            "entity": row.entity,
            "entity_id": row.entity_id,
            "action": row.action,
            "payload": row.payload,
            "created_at": row.created_at.isoformat(),
        }
        for row in rows
    ]
    return SyncPullResponse(
        since=since,
        until=rows[-1].sequence if rows else since,
        changes=changes,
        server_time=utcnow(),
    )


@router.get("/sync/bootstrap")
def sync_bootstrap(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client_query = select(Client).where(Client.deleted_at.is_(None))
    if user.role != "admin":
        client_query = client_query.where(Client.owner_id == user.id)
    clients = list(db.scalars(client_query))
    tasks = list(
        db.scalars(
            select(Task).where(
                (Task.assignee_id == user.id) if user.role != "admin" else True,
                Task.status == "open",
                Task.deleted_at.is_(None),
            ).limit(500)
        )
    )
    return {
        "user": UserOut.model_validate(user).model_dump(),
        "clients": [
            {"id": c.id, "name": c.name, "status": c.status, "version": c.version} for c in clients
        ],
        "tasks": [
            {
                "id": t.id,
                "client_id": t.client_id,
                "title": t.title,
                "due_date": t.due_date,
                "priority": t.priority,
                "version": t.version,
            }
            for t in tasks
        ],
        "server_time": utcnow().isoformat(),
    }


@router.get("/sync/status")
def sync_status(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    last = db.scalar(select(func.max(ChangeLog.sequence))) or 0
    ops = db.scalar(
        select(func.count()).select_from(SyncOperation).where(SyncOperation.user_id == user.id)
    ) or 0
    return {"cursor": int(last), "operations": int(ops), "server_time": utcnow().isoformat()}
