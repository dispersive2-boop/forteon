# -*- coding: utf-8 -*-
"""Правило «одно живое напоминание на событие» (п.22 «30 идей»).

Почему это нужно
----------------
Заметку можно разобрать повторно: AI переписывает задачи, и старый код
создавал НОВОЕ уведомление «Нужно проверить разбор заметки» на ту же самую
задачу. У менеджера копились дубли: три одинаковых колокольчика про одно и
то же. Повторяющееся событие должно ОБНОВЛЯТЬ одно напоминание, а не плодить
копии.

Когда создаём новое, а когда обновляем
--------------------------------------
* Уведомление ещё не прочитано → обновляем его (свежий текст, новый срок).
  Менеджер не видел старое, значит и смысла держать два нет.
* Уведомление прочитано → создаём новое. Менеджер уже закрыл прошлое
  событие, и повторное — это действительно новое дело, а не дубль.
* Прочитанное, но отложенное (snooze вернул его в pending) — тоже живое
  напоминание, его обновляем.
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Notification, utcnow


def upsert_reminder(
    db: Session,
    *,
    user_id: str,
    title: str,
    body: str | None = None,
    task_id: str | None = None,
    channel: str = "in_app",
    scheduled_at: datetime | None = None,
) -> tuple[Notification, bool]:
    """Возвращает (уведомление, создано_ли_новое).

    Ищем только «живые» напоминания: непрочитанные и не отложенные на будущее.
    Отложенное трогать нельзя — иначе snooze молча отменится при следующем
    разборе заметки, а менеджер уже сказал «напомни позже».
    """
    now = utcnow()
    conditions = [
        Notification.user_id == user_id,
        Notification.title == title,
        Notification.channel == channel,
        Notification.read_at.is_(None),
        Notification.scheduled_at <= now,
    ]
    if task_id:
        conditions.append(Notification.task_id == task_id)
    else:
        conditions.append(Notification.task_id.is_(None))

    existing = db.scalar(
        select(Notification).where(*conditions).order_by(Notification.id.desc()).limit(1)
    )
    when = scheduled_at or now
    if existing is not None:
        # Прочитанное не попадает сюда, поэтому обновляем смело: старое
        # напоминание менеджер ещё не видел.
        existing.body = body
        existing.scheduled_at = when
        existing.delivered_at = now
        existing.status = "pending"
        return existing, False

    created = Notification(
        user_id=user_id,
        task_id=task_id,
        channel=channel,
        title=title,
        body=body,
        scheduled_at=when,
        delivered_at=utcnow(),
        status="pending",
    )
    db.add(created)
    return created, True
