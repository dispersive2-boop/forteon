"""Задачи и планировщик (день/неделя/месяц/год)."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, ensure_version, get_client_or_404, get_current_user
from ..models import Client, Notification, Task, User, utcnow
from ..schemas import (
    PlannerOut,
    PlannerSummary,
    TaskComplete,
    TaskCreate,
    TaskListOut,
    TaskOut,
    TaskReschedule,
    TaskUpdate,
    TodayCounters,
    TodayOut,
)
from ..services.ai import make_dedupe_key
from ..services.dates import to_date

router = APIRouter(tags=["tasks"])


def _task_out(task: Task, client_name: str | None = None) -> TaskOut:
    out = TaskOut.model_validate(task)
    out.client_name = client_name
    return out


def _scope_query(user: User):
    query = select(Task).where(Task.deleted_at.is_(None))
    if user.role != "admin":
        query = query.where(Task.assignee_id == user.id)
    return query


def _task_for_user(db: Session, user: User, task_id: str) -> Task:
    task = db.get(Task, task_id)
    if task is None or task.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Задача не найдена"})
    get_client_or_404(db, user, task.client_id)
    return task


@router.get("/tasks", response_model=TaskListOut)
def list_tasks(
    status_filter: str | None = Query(default="open", alias="status"),
    client_id: str | None = None,
    origin: str | None = None,
    priority: str | None = None,
    needs_review: bool | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = _scope_query(user)
    if status_filter and status_filter != "all":
        query = query.where(Task.status == status_filter)
    if client_id:
        get_client_or_404(db, user, client_id)
        query = query.where(Task.client_id == client_id)
    if origin:
        query = query.where(Task.origin == origin)
    if priority:
        query = query.where(Task.priority == priority)
    if needs_review is not None:
        query = query.where(Task.needs_review.is_(needs_review))
    if date_from:
        query = query.where(Task.due_date.is_not(None), Task.due_date >= date_from)
    if date_to:
        query = query.where(Task.due_date.is_not(None), Task.due_date <= date_to)

    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    tasks = list(db.scalars(query.order_by(Task.due_date.is_(None), Task.due_date, Task.created_at).limit(limit)))
    names = _client_names(db, {t.client_id for t in tasks})
    return TaskListOut(items=[_task_out(t, names.get(t.client_id)) for t in tasks], total=total)


def _client_names(db: Session, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = db.execute(select(Client.id, Client.name).where(Client.id.in_(ids)))
    return {row[0]: row[1] for row in rows}


@router.post("/tasks", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(payload: TaskCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, payload.client_id)
    due_at = payload.due_at
    due_date = payload.due_date or to_date(due_at)
    if due_date is None and due_at is None:
        due_date = None

    task = Task(
        client_id=client.id,
        project_id=payload.project_id,
        assignee_id=user.id,
        title=payload.title.strip(),
        description=payload.description,
        type=payload.type,
        priority=payload.priority,
        status="open",
        due_at=due_at,
        due_date=due_date,
        timezone=payload.timezone or user.timezone,
        origin="manual",
        conditional=payload.conditional,
        needs_review=due_date is None,
        review_reason="Срок не указан" if due_date is None else None,
        dedupe_key=make_dedupe_key(client.id, payload.title, due_at),
    )
    db.add(task)
    db.flush()
    audit(db, user, "task", task.id, "created", {"client_id": client.id})
    db.commit()
    db.refresh(task)
    return _task_out(task, client.name)


# ---------------------------------------------------------------- экран «Сегодня»
# ВАЖНО: маршрут объявлен ДО `/tasks/{task_id}`. Иначе FastAPI матчит
# "today" как task_id и возвращает 404 — проверено фактическим запросом.
_PRIORITY_WEIGHT = {"critical": 0, "high": 1, "normal": 2, "low": 3}


def _today_sort_key(task: Task):
    """Просроченные -> критичные -> по времени (требование п.22)."""
    today = date.today()
    overdue = 0 if (task.due_date and task.due_date < today) else 1
    priority = _PRIORITY_WEIGHT.get(task.priority, 2)
    # Задачи без времени — в конце дня, а не с выдуманным «09:00» (п.27).
    no_time = 1 if task.due_at is None else 0
    return (overdue, priority, no_time, task.due_at or datetime.max, task.created_at)


@router.get("/tasks/today", response_model=TodayOut)
def tasks_today(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Всё для главного экрана одним запросом.

    Возвращает открытые задачи со сроком «сегодня или раньше», а также
    закрытые сегодня. Задачи без срока в список не попадают — они живут
    в блоке «Уточнить», чтобы не изобретать дедлайны.
    """
    today = date.today()
    open_rows = list(
        db.scalars(
            _scope_query(user)
            .where(Task.status == "open")
            .where(Task.due_date.is_not(None))
            .where(Task.due_date <= today)
        )
    )
    open_rows.sort(key=_today_sort_key)

    done_rows = list(
        db.scalars(
            _scope_query(user)
            .where(Task.status == "done")
            .where(Task.completed_at.is_not(None))
            .where(Task.completed_at >= datetime.combine(today, time.min))
            .order_by(Task.completed_at.desc())
            .limit(50)
        )
    )

    names = _client_names(db, {t.client_id for t in open_rows + done_rows})

    # Счётчики считаем по одной выборке, а не тремя отдельными запросами.
    counters_scope = list(db.scalars(_scope_query(user).where(Task.status == "open")))
    week_end = today + timedelta(days=7)
    payments = sum(1 for t in counters_scope if t.type == "payment" and t.due_date and t.due_date <= week_end)
    review = sum(1 for t in counters_scope if t.needs_review)
    week = sum(1 for t in counters_scope if t.due_date and today < t.due_date <= week_end)
    overdue = sum(1 for t in counters_scope if t.due_date and t.due_date < today and not t.needs_review)
    todays = sum(1 for t in counters_scope if t.due_date == today)

    return TodayOut(
        date=today,
        counters=TodayCounters(
            today=todays,
            overdue=overdue,
            payments=payments,
            review=review,
            done_today=len(done_rows),
            week=week,
        ),
        items=[_task_out(t, names.get(t.client_id)) for t in open_rows],
        done=[_task_out(t, names.get(t.client_id)) for t in done_rows],
    )


@router.get("/tasks/{task_id}", response_model=TaskOut)
def get_task(task_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    task = _task_for_user(db, user, task_id)
    client = db.get(Client, task.client_id)
    return _task_out(task, client.name if client else None)


@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(task_id: str, payload: TaskUpdate, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    task = _task_for_user(db, user, task_id)
    ensure_version(task, payload.version)
    data = payload.model_dump(exclude_unset=True, exclude={"version"})
    for key, value in data.items():
        if value is not None:
            setattr(task, key, value)
    if "due_at" in data and data["due_at"] is not None:
        task.due_date = to_date(data["due_at"])
        task.needs_review = False
        task.review_reason = None
    task.version = (task.version or 1) + 1
    db.commit()
    db.refresh(task)
    return _task_out(task)


@router.post("/tasks/{task_id}/complete", response_model=TaskOut)
def complete_task(task_id: str, payload: TaskComplete, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    task = _task_for_user(db, user, task_id)
    task.status = "done"
    task.completed_at = utcnow()
    task.result_note = payload.result_note
    task.version = (task.version or 1) + 1
    audit(db, user, "task", task.id, "completed")
    db.commit()
    db.refresh(task)
    return _task_out(task)


@router.post("/tasks/{task_id}/reopen", response_model=TaskOut)
def reopen_task(task_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    task = _task_for_user(db, user, task_id)
    task.status = "open"
    task.completed_at = None
    task.version = (task.version or 1) + 1
    audit(db, user, "task", task.id, "reopened")
    db.commit()
    db.refresh(task)
    return _task_out(task)


@router.post("/tasks/{task_id}/reschedule", response_model=TaskOut)
def reschedule_task(task_id: str, payload: TaskReschedule, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    task = _task_for_user(db, user, task_id)
    task.due_at = payload.due_at
    task.due_date = payload.due_date or to_date(payload.due_at)
    task.needs_review = task.due_date is None
    task.review_reason = None if task.due_date else "Срок требует уточнения"
    task.version = (task.version or 1) + 1
    audit(db, user, "task", task.id, "rescheduled", {"reason": payload.reason})
    db.commit()
    db.refresh(task)
    return _task_out(task)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    task = _task_for_user(db, user, task_id)
    task.deleted_at = utcnow()
    task.version = (task.version or 1) + 1
    audit(db, user, "task", task.id, "deleted")
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------- planner
def _planner_data(db: Session, user: User) -> dict[str, list[Task]]:
    today = date.today()
    week_end = today + timedelta(days=7)
    rows = list(
        db.scalars(
            _scope_query(user).where(Task.status == "open").order_by(Task.due_date.is_(None), Task.due_date)
        )
    )
    overdue = [t for t in rows if t.due_date and t.due_date < today and not t.needs_review]
    needs_review = [t for t in rows if t.needs_review]
    todays = [t for t in rows if t.due_date == today]
    week = [t for t in rows if t.due_date and today < t.due_date <= week_end]
    later = [
        t for t in rows
        if (t.due_date and t.due_date > week_end) or (t.due_date is None and not t.needs_review)
    ]
    return {"overdue": overdue, "today": todays, "week": week, "later": later, "needs_review": needs_review}


@router.get("/planner", response_model=PlannerOut)
def planner(
    date_from: date | None = None,
    date_to: date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    buckets = _planner_data(db, user)
    ids = {t.client_id for items in buckets.values() for t in items}
    names = _client_names(db, ids)
    today = date.today()
    return PlannerOut(
        date_from=date_from or today,
        date_to=date_to or (today + timedelta(days=7)),
        overdue=[_task_out(t, names.get(t.client_id)) for t in buckets["overdue"]],
        today=[_task_out(t, names.get(t.client_id)) for t in buckets["today"]],
        week=[_task_out(t, names.get(t.client_id)) for t in buckets["week"]],
        later=[_task_out(t, names.get(t.client_id)) for t in buckets["later"]],
        needs_review=[_task_out(t, names.get(t.client_id)) for t in buckets["needs_review"]],
    )


@router.get("/planner/summary", response_model=PlannerSummary)
def planner_summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    buckets = _planner_data(db, user)
    completed_today = db.scalar(
        select(func.count()).select_from(Task).where(
            Task.assignee_id == user.id if user.role != "admin" else True,
            Task.status == "done",
            Task.completed_at.is_not(None),
            Task.completed_at >= datetime.combine(date.today(), time.min),
            Task.deleted_at.is_(None),
        )
    ) or 0
    return PlannerSummary(
        today=len(buckets["today"]),
        overdue=len(buckets["overdue"]),
        week=len(buckets["week"]),
        needs_review=len(buckets["needs_review"]),
        completed_today=int(completed_today),
    )


@router.get("/planner/overdue", response_model=list[TaskOut])
def planner_overdue(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    buckets = _planner_data(db, user)
    names = _client_names(db, {t.client_id for t in buckets["overdue"]})
    return [_task_out(t, names.get(t.client_id)) for t in buckets["overdue"]]


# ---------------------------------------------------------------- notifications
@router.get("/notifications")
def list_notifications(limit: int = 50, db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)):
    rows = db.scalars(
        select(Notification).where(Notification.user_id == user.id)
        .order_by(Notification.scheduled_at.desc()).limit(limit)
    )
    return [
        {
            "id": n.id,
            "task_id": n.task_id,
            "channel": n.channel,
            "title": n.title,
            "body": n.body,
            "scheduled_at": n.scheduled_at,
            "read_at": n.read_at,
            "status": n.status,
        }
        for n in rows
    ]


@router.post("/notifications/{notification_id}/read")
def read_notification(notification_id: str, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Уведомление не найдено"})
    notification.read_at = utcnow()
    notification.status = "read"
    db.commit()
    return {"status": "ok"}
