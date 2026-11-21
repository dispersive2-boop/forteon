"""Задачи и планировщик (день/неделя/месяц/год)."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta

import json

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, ensure_version, get_client_or_404, get_current_user
from ..models import AuditLog, Client, Note, Notification, Task, User, utcnow
from ..schemas import (
    PlannerOut,
    PlannerSummary,
    TaskBulkAction,
    TaskChatNote,
    TaskChatOut,
    TaskComplete,
    TaskCreate,
    TaskHistoryOut,
    TaskListOut,
    TaskOut,
    TaskReschedule,
    TaskReviewDecision,
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

    # П0 AI Task Extraction 2.0, п.1–2: отсутствие срока — не повод требовать
    # уточнения. Раньше здесь стояло needs_review = (due_date is None), из-за
    # чего ЛЮБАЯ задача, созданная вручную без даты, попадала в «Уточнить» и
    # выглядела как ошибка разбора. Задача без срока — нормальная задача, она
    # просто живёт в разделе «Без срока».
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
        needs_review=False,
        review_reason=None,
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


@router.get("/tasks/{task_id}/chat", response_model=TaskChatOut)
def task_chat(
    task_id: str,
    limit: int = Query(default=30, ge=1, le=100),
    before: datetime | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Задача как чат: карточка + вся переписка-заметки по клиенту.

    Менеджер открывает задачу и видит, о чём договаривались раньше, — не
    переключаясь на экран заметок и не теряя контекст. Всё одним запросом:
    три отдельных запроса давали рассинхрон между задачей и лентой.

    Заметки идут от новых к старым (`before` — курсор пагинации, как в ленте).
    """
    task = _task_for_user(db, user, task_id)
    client = db.get(Client, task.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Клиент не найден"})

    query = (
        select(Note, User.full_name)
        .outerjoin(User, User.id == Note.author_id)
        .where(Note.client_id == client.id, Note.deleted_at.is_(None))
    )
    if before is not None:
        query = query.where(Note.created_at < before)
    rows = db.execute(query.order_by(Note.created_at.desc()).limit(limit + 1)).all()

    has_more = len(rows) > limit
    rows = rows[:limit]

    # Какие заметки породили живую задачу — показываем меткой в ленте.
    spawned = set(
        db.scalars(
            select(Task.source_note_id).where(
                Task.client_id == client.id,
                Task.deleted_at.is_(None),
                Task.source_note_id.is_not(None),
            )
        )
    )

    notes = [
        TaskChatNote(
            id=note.id,
            body=note.body,
            source_type=note.source_type,
            ai_status=note.ai_status,
            created_at=note.created_at,
            author_name=author_name,
            spawned_task=note.id in spawned,
        )
        for note, author_name in rows
    ]

    return TaskChatOut(
        task=_task_out(task, client.name),
        client={
            "id": client.id,
            "name": client.name,
            "status": client.status,
            "type": client.type,
        },
        notes=notes,
        has_more=has_more,
        next_before=rows[-1][0].created_at if has_more and rows else None,
    )


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
        task.review_question = None
    # Менеджер снял пометку уточнения вручную — вопрос больше не нужен.
    if data.get("needs_review") is False:
        task.review_reason = None
        task.review_question = None
    task.version = (task.version or 1) + 1
    audit(db, user, "task", task.id, "updated", {k: str(v) for k, v in data.items()})
    db.commit()
    db.refresh(task)
    return _task_out(task)


@router.post("/tasks/{task_id}/review", response_model=TaskOut)
def review_task(task_id: str, payload: TaskReviewDecision,
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Решение по задаче, предложенной AI (п.23).

    AI иногда ошибается: предлагает задачу на уже сделанное или неверно
    понимает, кто действует. Менеджер должен иметь возможность принять,
    поправить или отклонить — иначе единственный выход удалять задачу
    вручную, и причина ошибки теряется.
    """
    task = _task_for_user(db, user, task_id)
    decision = (payload.decision or "").strip().lower()

    if decision == "reject":
        task.deleted_at = utcnow()
        task.version = (task.version or 1) + 1
        audit(db, user, "task", task.id, "rejected_by_user",
              {"comment": payload.comment or "", "title": task.title})
        db.commit()
        return _task_out(task)

    if decision not in ("accept", "edit"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "bad_decision",
                    "message": "Ожидается accept, edit или reject"},
        )

    if payload.title:
        task.title = payload.title.strip()[:512]
    if payload.actor in ("us", "client"):
        task.actor = payload.actor
    if payload.due_date is not None:
        task.due_date = payload.due_date
        task.due_at = datetime.combine(payload.due_date, time(10, 0))
    if payload.comment:
        task.description = ((task.description or "") + "\n" + payload.comment).strip()

    task.needs_review = False
    task.review_reason = None
    task.review_question = None
    task.version = (task.version or 1) + 1
    audit(db, user, "task", task.id, "accepted_by_user",
          {"decision": decision, "title": task.title})
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
    # п.1–2: перенос без даты не возвращает задачу в «Уточнить». Уточнение —
    # это про неясный смысл события, а не про пустой календарь. Если менеджер
    # сознательно оставил задачу без срока, это его решение, а не ошибка AI.
    task.needs_review = False
    task.review_reason = None
    task.review_question = None
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


@router.post("/tasks/bulk")
def bulk_tasks(payload: TaskBulkAction, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)):
    """Массовые действия: закрыть, вернуть в работу, перенести срок.

    Один запрос вместо N: планировщик выделяет пачку задач и применяет
    действие сразу. Чужие задачи и удалённые пропускаем молча —
    менеджер не должен получить 404 из-за того, что коллега уже закрыл.
    """
    ids = list(dict.fromkeys(payload.ids))[:200]
    if payload.action == "reschedule" and payload.due_date is None and payload.due_at is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "due_required", "message": "Для переноса нужен новый срок"},
        )

    done = 0
    skipped = 0
    for task_id in ids:
        task = db.get(Task, task_id)
        if task is None or task.deleted_at is not None:
            skipped += 1
            continue
        try:
            get_client_or_404(db, user, task.client_id)
        except HTTPException:
            skipped += 1
            continue

        if payload.action == "complete":
            if task.status == "done":
                skipped += 1
                continue
            task.status = "done"
            task.completed_at = utcnow()
            if payload.result_note:
                task.result_note = payload.result_note
            audit(db, user, "task", task.id, "completed", {"bulk": True})
        elif payload.action == "reopen":
            if task.status != "done":
                skipped += 1
                continue
            task.status = "open"
            task.completed_at = None
            audit(db, user, "task", task.id, "reopened", {"bulk": True})
        else:  # reschedule
            task.due_at = payload.due_at
            task.due_date = payload.due_date or to_date(payload.due_at)
            task.needs_review = False
            task.review_reason = None
            task.review_question = None
            audit(db, user, "task", task.id, "rescheduled", {"bulk": True, "reason": "массовый перенос"})
        task.version = (task.version or 1) + 1
        done += 1

    db.commit()
    return {"done": done, "skipped": skipped, "action": payload.action}


@router.get("/tasks/{task_id}/history", response_model=TaskHistoryOut)
def task_history(task_id: str, limit: int = Query(default=50, ge=1, le=200),
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """История задачи из журнала аудита.

    Раньше был только финальный статус: менеджер не видел, кто и когда
    закрыл/перенёс/вернул. Источник — audit_log, а не догадки интерфейса.
    """
    _task_for_user(db, user, task_id)
    rows = list(
        db.execute(
            select(AuditLog, User.full_name)
            .outerjoin(User, User.id == AuditLog.actor_id)
            .where(AuditLog.entity == "task", AuditLog.entity_id == task_id)
            .order_by(AuditLog.created_at.desc())
            .limit(limit)
        ).all()
    )
    items = []
    for row, actor in rows:
        meta = None
        if row.metadata_json:
            try:
                meta = json.loads(row.metadata_json)
            except (TypeError, ValueError):
                meta = None
        items.append(
            {
                "id": row.id,
                "action": row.action,
                "actor": actor,
                "metadata": meta,
                "created_at": row.created_at,
            }
        )
    return TaskHistoryOut(items=items, total=len(items))


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


@router.post("/notifications/{notification_id}/read", status_code=204)
def read_notification(notification_id: str, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    notification = db.get(Notification, notification_id)
    if notification is None or notification.user_id != user.id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Уведомление не найдено"})
    notification.read_at = utcnow()
    notification.status = "read"
    db.commit()
    return None


@router.post("/notifications/read-all")
def read_all_notifications(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Прочитать все непрочитанные одним нажатием.

    Раньше приходилось тыкать в каждое: при десятке просрочек это была
    рутинная работа вместо работы с клиентом.
    """
    rows = list(
        db.scalars(
            select(Notification).where(
                Notification.user_id == user.id,
                Notification.read_at.is_(None),
            )
        )
    )
    now = utcnow()
    for n in rows:
        n.read_at = now
        n.status = "read"
    db.commit()
    return {"status": "ok", "read": len(rows)}


@router.get("/notifications/unread-count")
def unread_notifications_count(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Счётчик для колокольчика. Отдельно от /tasks/today: уведомления
    живут своей жизнью (просрочка может быть прочитана, а новое — нет)."""
    total = db.scalar(
        select(func.count()).select_from(Notification).where(
            Notification.user_id == user.id,
            Notification.read_at.is_(None),
        )
    ) or 0
    return {"count": int(total)}
