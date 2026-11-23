# -*- coding: utf-8 -*-
"""Утренний дайджест менеджера (п.23 «30 идей»).

Почему это нужно
----------------
Главный экран «Сегодня» менеджер открывает сам. Но чтобы он вспомнил про
него утром, нужен один короткий пинг: «сегодня 4 задачи, 1 просрочена,
1 оплата». Не список задач с деталями — сводка, по которой понятно, стоит
ли открывать систему прямо сейчас.

Как работает
------------
Функция `build_digest(db, user, today)` считает сводку за день и ничего не
пишет. Отдельная `send_digest(db, user, today)` формирует текст и кладёт
уведомление через `upsert_reminder`: повторный запуск в тот же день НЕ
плодит копии (заголовок содержит дату, поэтому вчерашняя сводка не мешает
сегодняшней).

Время задаёт сам менеджер (`users.digest_time`, «ЧЧ:ММ»). Пусто — рассылка
выключена. Планировщик вызывает `send_due_digests(db, now)` и сама функция
решает, кому пора.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Client, Invoice, PaymentAllocation, Task, User, utcnow
from .notifications import upsert_reminder

DIGEST_TITLE_PREFIX = "Утренняя сводка"


@dataclass
class Digest:
    """Что показать менеджеру утром. Числа, не задачи."""

    today: date
    due_today: int = 0
    overdue: int = 0
    needs_review: int = 0
    payments_due: int = 0
    invoices_overdue: int = 0
    # Готовые строки — чтобы фронтенд и уведомление говорили одинаково.
    lines: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        return not any([
            self.due_today, self.overdue, self.needs_review,
            self.payments_due, self.invoices_overdue,
        ])

    def text(self) -> str:
        if self.is_empty:
            return "На сегодня нет задач и просрочек. Хороший день, чтобы заняться клиентами без срочных дел."
        return " · ".join(self.lines)


def _plural(n: int, one: str, few: str, many: str) -> str:
    """Русское склонение: 1 задача, 2 задачи, 5 задач."""
    if n % 100 in range(11, 15):
        return many
    if n % 10 == 1:
        return one
    if n % 10 in (2, 3, 4):
        return few
    return many


def _task_phrase(n: int) -> str:
    return f"{n} {_plural(n, 'задача', 'задачи', 'задач')}"


def build_digest(db: Session, user: User, today: date | None = None) -> Digest:
    """Считает сводку на день. Ничего не пишет в базу."""
    day = today or utcnow().date()
    scope = (
        select(Task)
        .where(Task.assignee_id == user.id, Task.deleted_at.is_(None), Task.status == "open")
    )
    rows = list(db.scalars(scope))

    digest = Digest(today=day)
    week_end = day + timedelta(days=7)
    for task in rows:
        if task.needs_review:
            digest.needs_review += 1
            # Уточнение не показываем как «задачу на сегодня»: её ещё нет.
            continue
        if task.due_date is None:
            continue
        if task.due_date < day:
            digest.overdue += 1
        elif task.due_date == day:
            digest.due_today += 1
        if task.type == "payment" and day <= task.due_date <= week_end:
            digest.payments_due += 1

    # Просроченные счета — только по клиентам этого менеджера, иначе сводка
    # показала бы чужие деньги (и это выглядело бы как утечка).
    invoice_rows = db.scalars(
        select(Invoice)
        .join(Client, Client.id == Invoice.client_id)
        .where(
            Client.owner_id == user.id,
            Client.deleted_at.is_(None),
            Invoice.deleted_at.is_(None),
            Invoice.status == "issued",
            Invoice.due_date.is_not(None),
            Invoice.due_date < day,
        )
    )
    for invoice in invoice_rows:
        # Сумма зачётов одним запросом на счёт: их мало, но N+1 здесь
        # не нужен — сводка должна считаться быстро.
        paid = db.scalar(
            select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(
                PaymentAllocation.invoice_id == invoice.id
            )
        )
        if invoice.amount and float(invoice.amount) > float(paid or 0):
            digest.invoices_overdue += 1

    if digest.due_today:
        digest.lines.append(f"на сегодня {_task_phrase(digest.due_today)}")
    if digest.overdue:
        digest.lines.append(f"просрочено {_task_phrase(digest.overdue)}")
    if digest.payments_due:
        digest.lines.append(
            f"{digest.payments_due} {_plural(digest.payments_due, 'оплата', 'оплаты', 'оплат')} на неделе"
        )
    if digest.invoices_overdue:
        digest.lines.append(
            f"{digest.invoices_overdue} "
            f"{_plural(digest.invoices_overdue, 'счёт просрочен', 'счёта просрочены', 'счетов просрочено')}"
        )
    if digest.needs_review:
        digest.lines.append(
            f"{digest.needs_review} "
            f"{_plural(digest.needs_review, 'задача ждёт уточнения', 'задачи ждут уточнения', 'задач ждут уточнения')}"
        )
    return digest


def send_digest(db: Session, user: User, today: date | None = None) -> tuple[str, bool]:
    """Формирует сводку и кладёт её в уведомления. Возвращает (текст, создано_ли)."""
    digest = build_digest(db, user, today)
    title = f"{DIGEST_TITLE_PREFIX} на {digest.today:%d.%m.%Y}"
    _, created = upsert_reminder(
        db,
        user_id=user.id,
        title=title,
        body=digest.text(),
        channel="in_app",
    )
    return digest.text(), created


def digest_due(user: User, now: datetime | None = None) -> bool:
    """Пора ли отправлять: время задано и уже наступило."""
    if not user.digest_time:
        return False
    try:
        hour, minute = (int(part) for part in user.digest_time.split(":"))
    except (ValueError, AttributeError):
        return False
    moment = now or utcnow()
    return (moment.hour, moment.minute) >= (hour, minute)


def send_due_digests(db: Session, now: datetime | None = None) -> int:
    """Рассылает сводку всем, кому пора. Повторный вызов в тот же день
    не плодит копии — за это отвечает уникальный заголовок с датой."""
    moment = now or utcnow()
    users = db.scalars(select(User).where(User.is_active.is_(True)))
    sent = 0
    for user in users:
        if not digest_due(user, moment):
            continue
        _, created = send_digest(db, user, moment.date())
        if created:
            sent += 1
    return sent
