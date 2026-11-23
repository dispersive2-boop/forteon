"""Следующий шаг и риск по клиенту (п.19 и п.20 «30 идей»).

Зачем отдельный модуль
----------------------
Список клиентов раньше показывал только название и статус. Менеджер
открывал карточки по очереди, чтобы понять, за что взяться. Две подсказки
решают это, но их нельзя считать «на глазок» в шаблоне:

  * **следующий шаг** — конкретное ближайшее дело, а не «есть задачи»;
  * **риск** — с причиной («просрочено на 5 дней»), а не безымянный флажок.

Расчёт живёт на сервере: правила должны быть одинаковыми для списка,
мобильной карточки и отчётов. Один запрос на страницу клиентов — не N+1.

Что считается риском
--------------------
1. Просроченные задачи — критично, если просрочка больше 3 дней.
2. Ожидание клиента дольше 7 дней — сделка встала.
3. Просроченная оплата — деньги не пришли, работа может встать.
4. Нет ни одного контакта — некому звонить, это тоже риск.

Правила намеренно простые и объяснимые: менеджер должен видеть, почему
система подсветила клиента, и уметь с этим не согласиться.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Client, ClientContact, Invoice, Task

# Порог, после которого просрочка перестаёт быть «случайной».
CRITICAL_OVERDUE_DAYS = 3
# Сколько ждём ответа клиента, прежде чем считаем, что дело встало.
STALE_WAITING_DAYS = 7


@dataclass(frozen=True)
class NextStep:
    title: str
    kind: str  # task | waiting | overdue
    due_date: date | None


@dataclass(frozen=True)
class Risk:
    reason: str
    level: str  # warning | critical


@dataclass
class ClientSignals:
    next_step: NextStep | None = None
    risk: Risk | None = None


def _plural_days(count: int) -> str:
    """«1 день», «2 дня», «5 дней» — иначе «просрочено на 5 день»."""
    tail = count % 100
    if 11 <= tail <= 14:
        return f"{count} дней"
    last = count % 10
    if last == 1:
        return f"{count} день"
    if 2 <= last <= 4:
        return f"{count} дня"
    return f"{count} дней"


def _money_text(value: float) -> str:
    return f"{value:,.0f}".replace(",", " ") + " ₽"


def collect_signals(
    db: Session,
    client_ids: list[str],
    today: date,
) -> dict[str, ClientSignals]:
    """Считает подсказки для набора клиентов тремя запросами, а не N+1.

    Возвращает словарь по id клиента. Клиенты без данных получают пустые
    подсказки — фронтенд просто ничего не нарисует.
    """
    if not client_ids:
        return {}

    result = {client_id: ClientSignals() for client_id in client_ids}

    tasks = db.scalars(
        select(Task).where(
            Task.client_id.in_(client_ids),
            Task.status == "open",
            Task.deleted_at.is_(None),
        )
    ).all()

    # Группируем задачи по клиенту, чтобы выбрать ближайшую и просрочки.
    per_client: dict[str, list[Task]] = {}
    for task in tasks:
        per_client.setdefault(task.client_id, []).append(task)

    for client_id, items in per_client.items():
        waiting = [t for t in items if t.event_kind == "waiting"]
        # Ожидание клиента со сроком в прошлом — это НЕ наша просрочка:
        # мы сделали свой шаг и ждём другую сторону. Иначе менеджер видел
        # «Просрочено: ждём реквизиты» и шёл извиняться за свой же корректный
        # поступок. Такие задачи живут в отдельном списке ожиданий.
        overdue = [
            t for t in items
            if t.due_date and t.due_date < today and t.event_kind != "waiting"
        ]
        upcoming = [
            t for t in items
            if t.due_date and t.due_date >= today and t.event_kind != "waiting"
        ]
        upcoming_waiting = [t for t in waiting if t.due_date and t.due_date >= today]

        # Следующий шаг: сначала просрочка, затем ближайший срок, затем ожидание.
        step: NextStep | None = None
        if overdue:
            first = min(overdue, key=lambda t: t.due_date)
            step = NextStep(title=first.title, kind="overdue", due_date=first.due_date)
        elif upcoming:
            first = min(upcoming, key=lambda t: t.due_date)
            step = NextStep(title=first.title, kind="task", due_date=first.due_date)
        elif upcoming_waiting:
            first = min(upcoming_waiting, key=lambda t: t.due_date)
            step = NextStep(title=first.title, kind="waiting", due_date=first.due_date)
        elif waiting:
            first = max(waiting, key=lambda t: t.updated_at or t.created_at)
            step = NextStep(title=first.title, kind="waiting", due_date=first.due_date)
        elif items:
            first = items[0]
            step = NextStep(title=first.title, kind="task", due_date=first.due_date)

        signals = result[client_id]
        signals.next_step = step

        # Риск по задачам. Причину выбираем одну, самую весомую: список
        # причин превращается в шум, а менеджеру нужен один повод позвонить.
        if overdue:
            worst = max(overdue, key=lambda t: (today - t.due_date).days)
            days = (today - worst.due_date).days
            level = "critical" if days > CRITICAL_OVERDUE_DAYS else "warning"
            signals.risk = Risk(
                reason=f"Просрочено: «{worst.title[:60]}» — {_plural_days(days)}",
                level=level,
            )
        elif waiting:
            oldest = min(waiting, key=lambda t: t.created_at)
            started = (oldest.created_at.date() if oldest.created_at else today)
            days = (today - started).days
            if days > STALE_WAITING_DAYS:
                signals.risk = Risk(
                    reason=f"Ждём клиента {_plural_days(days)}: «{oldest.title[:60]}»",
                    level="warning",
                )

    # Просроченные счета: деньги важнее любых задач. Перекрываем риск задачи.
    invoices = db.scalars(
        select(Invoice).where(
            Invoice.client_id.in_(client_ids),
            Invoice.deleted_at.is_(None),
        )
    ).all()
    paid_allocations: dict[str, float] = {}
    if invoices:
        from ..models import PaymentAllocation

        for allocation in db.scalars(
            select(PaymentAllocation).where(PaymentAllocation.invoice_id.in_({i.id for i in invoices}))
        ).all():
            paid_allocations[allocation.invoice_id] = (
                paid_allocations.get(allocation.invoice_id, 0.0) + float(allocation.amount or 0)
            )

    for invoice in invoices:
        # Статусы счёта: draft|issued|paid|void. Просрочка важна только
        # для выставленного и неоплаченного; черновик ещё не отправляли.
        if invoice.status != "issued":
            continue
        if not invoice.due_date or invoice.due_date >= today:
            continue
        paid = paid_allocations.get(invoice.id, 0.0)
        outstanding = float(invoice.amount or 0) - paid
        if outstanding <= 0:
            continue
        days = (today - invoice.due_date).days
        result[invoice.client_id].risk = Risk(
            reason=f"Просрочена оплата на {_money_text(outstanding)} — {_plural_days(days)}",
            level="critical" if days > CRITICAL_OVERDUE_DAYS else "warning",
        )

    # Нет контактов — звонить некому. Это ниже по весу, чем деньги.
    contacts = db.scalars(
        select(ClientContact).where(ClientContact.client_id.in_(client_ids))
    ).all()
    has_contact = {contact.client_id for contact in contacts}
    for client_id in client_ids:
        if client_id in has_contact:
            continue
        signals = result[client_id]
        if signals.risk is None:
            signals.risk = Risk(reason="Нет контактов — некому позвонить", level="warning")

    return result


def signals_for_client(db: Session, client: Client, today: date) -> ClientSignals:
    """Одна карточка — тот же расчёт, чтобы список и деталь не расходились."""
    return collect_signals(db, [client.id], today).get(client.id, ClientSignals())


def stale_waiting_threshold(today: date) -> date:
    """Дата, раньше которой ожидание считается затянувшимся (для тестов)."""
    return today - timedelta(days=STALE_WAITING_DAYS)
