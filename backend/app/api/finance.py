"""Финансы: счета, оплаты, распределения (раздел 10).

Долг = выставлено по действующим счетам − распределённые оплаты.
Плановый доход проекта прибылью не является.

A-P0-2 (сохранность денежных данных):
* каждая денежная операция пишется в `audit_log` с суммами до и после;
* каждая операция попадает в `change_log` — иначе `/sync/pull` не отдаёт
  изменения офлайн-клиенту и курсор синхронизации навсегда остаётся нулевым;
* статус счёта пересчитывается и при добавлении, и при удалении
  распределения — раньше откат оплаты оставлял счёт «оплаченным»;
* проверка перераспределения идёт в одной транзакции с записью, поэтому
  два одновременных запроса не могут распределить одну сумму дважды.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, get_client_or_404, get_current_user
from ..models import PERSONAL_PLAN_TYPE, Invoice, Payment, PaymentAllocation, User, utcnow
from ..schemas import (
    AllocationIn,
    FinancialSummary,
    InvoiceCreate,
    InvoiceOut,
    PaymentCreate,
    PaymentOut,
)
from ..services.changes import ACTION_DELETE, ACTION_UPSERT, record_change

router = APIRouter(tags=["finance"])


def _allocation_totals(db: Session, invoice_ids: list[str]) -> dict[str, float]:
    if not invoice_ids:
        return {}
    rows = db.execute(select(PaymentAllocation.invoice_id, func.sum(PaymentAllocation.amount))
                      .where(PaymentAllocation.invoice_id.in_(invoice_ids))
                      .group_by(PaymentAllocation.invoice_id))
    return {invoice_id: round(float(amount), 2) for invoice_id, amount in rows}


def _remaining(invoice: Invoice, allocations: dict[str, float]) -> float:
    return max(round(float(invoice.amount or 0) - allocations.get(invoice.id, 0.0), 2), 0.0)


def _summary(db: Session, client_id: str) -> FinancialSummary:
    # Удалённые счета и оплаты в сумму долга не входят — иначе после удаления
    # счёта «долг» оставался прежним.
    invoices = list(db.scalars(
        select(Invoice).where(Invoice.client_id == client_id, Invoice.deleted_at.is_(None))
    ))
    payments = list(db.scalars(
        select(Payment).where(Payment.client_id == client_id, Payment.deleted_at.is_(None))
    ))
    invoice_ids = [i.id for i in invoices]
    allocations = _allocation_totals(db, invoice_ids)
    billed = sum(float(i.amount or 0) for i in invoices if i.status != "void")
    paid = sum(float(p.amount or 0) for p in payments)
    allocated = sum(allocations.values())
    today = date.today()
    overdue_amount = sum(
        _remaining(i, allocations) for i in invoices
        if i.status == "issued" and i.due_date and i.due_date < today
    )
    unpaid = [i for i in invoices if i.status == "issued"]

    return FinancialSummary(
        billed=round(billed, 2),
        paid=round(paid, 2),
        allocated=round(allocated, 2),
        debt=round(billed - allocated, 2),
        overdue_amount=round(overdue_amount, 2),
        invoices=len(invoices),
        unpaid_invoices=len(unpaid),
    )


@router.get("/clients/{client_id}/invoices", response_model=list[InvoiceOut])
def list_invoices(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    rows = list(db.scalars(
        select(Invoice).where(Invoice.client_id == client.id, Invoice.deleted_at.is_(None))
        .order_by(Invoice.due_date.desc())
    ))
    allocations = _allocation_totals(db, [invoice.id for invoice in rows])
    return [InvoiceOut.model_validate(invoice).model_copy(update={"remaining": _remaining(invoice, allocations)})
            for invoice in rows]


def _invoice_snapshot(invoice: Invoice) -> dict[str, Any]:
    """Что именно меняется в счёте — для аудита и журнала синхронизации."""
    return {
        "number": invoice.number,
        "amount": float(invoice.amount or 0),
        "currency": invoice.currency,
        "status": invoice.status,
        "issue_date": invoice.issue_date,
        "due_date": invoice.due_date,
        "project_id": invoice.project_id,
    }


@router.post("/clients/{client_id}/invoices", response_model=InvoiceOut, status_code=201)
def create_invoice(client_id: str, payload: InvoiceCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    invoice = Invoice(client_id=client.id, **payload.model_dump())
    db.add(invoice)
    db.flush()
    snapshot = _invoice_snapshot(invoice)
    audit(db, user, "invoice", invoice.id, "created",
          {"client_id": client.id, **snapshot})
    record_change(db, entity="invoice", entity_id=invoice.id, action=ACTION_UPSERT,
                  owner_id=client.owner_id, payload=snapshot)
    db.commit()
    db.refresh(invoice)
    return InvoiceOut.model_validate(invoice)


@router.patch("/invoices/{invoice_id}", response_model=InvoiceOut)
def update_invoice(invoice_id: str, payload: InvoiceCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    invoice = db.get(Invoice, invoice_id)
    if invoice is None or invoice.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Счёт не найден"})
    client = get_client_or_404(db, user, invoice.client_id)
    # Финансы не перезаписываются молча: изменение фиксируется в аудите
    before = _invoice_snapshot(invoice)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(invoice, key, value)
    invoice.version = (invoice.version or 1) + 1
    after = _invoice_snapshot(invoice)
    audit(db, user, "invoice", invoice.id, "updated", {"before": before, "after": after})
    record_change(db, entity="invoice", entity_id=invoice.id, action=ACTION_UPSERT,
                  owner_id=client.owner_id, payload=after)
    db.commit()
    db.refresh(invoice)
    return InvoiceOut.model_validate(invoice)


@router.delete("/invoices/{invoice_id}")
def delete_invoice(invoice_id: str, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """Удаление счёта — только если по нему нет распределённых оплат.

    Иначе деньги «исчезают» из отчёта: оплата осталась, а счёт, к которому она
    привязана, пропал. Сначала нужно снять распределения.
    """
    invoice = db.get(Invoice, invoice_id)
    if invoice is None or invoice.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Счёт не найден"})
    client = get_client_or_404(db, user, invoice.client_id)

    allocated = db.scalar(
        select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(
            PaymentAllocation.invoice_id == invoice.id
        )
    ) or 0
    if float(allocated) > 0.01:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "invoice_has_allocations",
                "message": "По счёту распределены оплаты. Сначала снимите распределения.",
            },
        )

    snapshot = _invoice_snapshot(invoice)
    invoice.deleted_at = utcnow()
    invoice.version = (invoice.version or 1) + 1
    audit(db, user, "invoice", invoice.id, "deleted", snapshot)
    record_change(db, entity="invoice", entity_id=invoice.id, action=ACTION_DELETE,
                  owner_id=client.owner_id, payload={"number": invoice.number})
    db.commit()
    return {"status": "ok"}


def _payment_snapshot(payment: Payment) -> dict[str, Any]:
    return {
        "amount": float(payment.amount or 0),
        "currency": payment.currency,
        "paid_at": payment.paid_at,
        "reference": payment.reference,
    }


@router.post("/clients/{client_id}/payments", response_model=PaymentOut, status_code=201)
def create_payment(client_id: str, payload: PaymentCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    payment = Payment(client_id=client.id, **payload.model_dump(exclude={"invoice_id"}))
    db.add(payment)
    db.flush()

    invoice = None
    if payload.invoice_id is not None:
        # INSERT открывает транзакцию записи в SQLite. В PostgreSQL
        # дополнительно блокируем строку счёта перед проверкой остатка.
        invoice = db.scalar(select(Invoice).where(
            Invoice.id == payload.invoice_id, Invoice.client_id == client.id,
            Invoice.deleted_at.is_(None),
        ).with_for_update())
        if invoice is None or invoice.status != "issued" or invoice.currency != payload.currency:
            db.rollback()
            raise HTTPException(status_code=422, detail={"message": "Выберите открытый счёт в валюте оплаты"})
        remaining = round(float(invoice.amount or 0) - _allocated_by_invoice(db, invoice.id), 2)
        if payload.amount > remaining:
            db.rollback()
            raise HTTPException(status_code=422, detail={"message": "Сумма оплаты превышает остаток по счёту"})

    snapshot = _payment_snapshot(payment)
    audit(db, user, "payment", payment.id, "created", {"client_id": client.id, **snapshot})
    record_change(db, entity="payment", entity_id=payment.id, action=ACTION_UPSERT,
                  owner_id=client.owner_id, payload={"client_id": client.id, **snapshot})
    if invoice is not None:
        _record_allocation(db, user, client.owner_id, payment, invoice, payload.amount)
    db.commit()
    db.refresh(payment)
    return PaymentOut.model_validate(payment)


@router.get("/clients/{client_id}/payments", response_model=list[PaymentOut])
def list_payments(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    rows = db.scalars(
        select(Payment).where(Payment.client_id == client.id, Payment.deleted_at.is_(None))
        .order_by(Payment.paid_at.desc())
    )
    return [PaymentOut.model_validate(p) for p in rows]


def _allocated_by_invoice(db: Session, invoice_id: str) -> float:
    total = db.scalar(
        select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(
            PaymentAllocation.invoice_id == invoice_id
        )
    ) or 0
    return round(float(total), 2)


def _sync_invoice_status(db: Session, invoice: Invoice) -> str:
    """Статус счёта следует за распределениями, а не за последним действием.

    Раньше статус только повышался до `paid`: после отката оплаты счёт
    оставался «оплаченным», и долг в сводке был занижен. Ручные состояния
    `draft` и `void` не трогаем.
    """
    if invoice.status not in ("issued", "paid"):
        return invoice.status
    covered = _allocated_by_invoice(db, invoice.id)
    amount = round(float(invoice.amount or 0), 2)
    new_status = "paid" if amount > 0 and covered >= amount else "issued"
    if new_status != invoice.status:
        invoice.status = new_status
        invoice.version = (invoice.version or 1) + 1
    return invoice.status


@router.post("/payments/{payment_id}/allocations")
def create_allocation(payment_id: str, payload: AllocationIn, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    payment = db.get(Payment, payment_id)
    if payment is None or payment.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Оплата не найдена"})
    client = get_client_or_404(db, user, payment.client_id)

    invoice = db.get(Invoice, payload.invoice_id)
    if invoice is None or invoice.deleted_at is not None or invoice.client_id != payment.client_id:
        raise HTTPException(status_code=400, detail={"code": "bad_invoice", "message": "Счёт не относится к клиенту"})
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail={"code": "bad_amount", "message": "Сумма должна быть больше нуля"})
    if invoice.status == "void":
        raise HTTPException(
            status_code=400,
            detail={"code": "invoice_void", "message": "Счёт аннулирован — распределять на него нельзя"},
        )

    allocated_total = db.scalar(
        select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(PaymentAllocation.payment_id == payment.id)
    ) or 0
    if float(allocated_total) + payload.amount > float(payment.amount or 0) + 0.01:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "over_allocation",
                "message": "Распределение превышает сумму оплаты",
                "details": {
                    "payment_amount": round(float(payment.amount or 0), 2),
                    "already_allocated": round(float(allocated_total), 2),
                },
            },
        )

    allocation = _record_allocation(db, user, client.owner_id, payment, invoice, payload.amount)
    db.commit()
    return {
        "id": allocation.id,
        "payment_id": allocation.payment_id,
        "invoice_id": allocation.invoice_id,
        "amount": float(allocation.amount),
        "invoice_status": invoice.status,
    }


def _record_allocation(
    db: Session, user: User, owner_id: str, payment: Payment, invoice: Invoice, amount: float,
) -> PaymentAllocation:
    allocation = PaymentAllocation(payment_id=payment.id, invoice_id=invoice.id, amount=amount)
    db.add(allocation)
    db.flush()

    status_after = _sync_invoice_status(db, invoice)
    audit(db, user, "allocation", allocation.id, "created",
          {"payment_id": payment.id, "invoice_id": invoice.id, "amount": amount,
           "invoice_status": status_after})
    # Событие на самом счёте: распределения удаляются физически, поэтому
    # в истории клиента их id уже не найти — а «оплата зачтена» должна
    # оставаться видимой.
    audit(db, user, "invoice", invoice.id, "allocation_added",
          {"payment_id": payment.id, "amount": amount,
           "allocated": _allocated_by_invoice(db, invoice.id),
           "status": status_after})
    record_change(db, entity="allocation", entity_id=allocation.id, action=ACTION_UPSERT,
                  owner_id=owner_id,
                  payload={"payment_id": payment.id, "invoice_id": invoice.id, "amount": amount})
    record_change(db, entity="invoice", entity_id=invoice.id, action=ACTION_UPSERT,
                  owner_id=owner_id,
                  payload={"status": status_after,
                           "allocated": _allocated_by_invoice(db, invoice.id)})
    return allocation


@router.delete("/payment-allocations/{allocation_id}")
def delete_allocation(allocation_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    allocation = db.get(PaymentAllocation, allocation_id)
    if allocation is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Распределение не найдено"})
    payment = db.get(Payment, allocation.payment_id)
    if payment is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Оплата не найдена"})
    client = get_client_or_404(db, user, payment.client_id)
    invoice = db.get(Invoice, allocation.invoice_id)
    amount = round(float(allocation.amount or 0), 2)

    audit(db, user, "allocation", allocation.id, "deleted",
          {"payment_id": allocation.payment_id, "invoice_id": allocation.invoice_id, "amount": amount})
    if invoice is not None:
        audit(db, user, "invoice", invoice.id, "allocation_removed",
              {"payment_id": allocation.payment_id, "amount": amount})
    record_change(db, entity="allocation", entity_id=allocation.id, action=ACTION_DELETE,
                  owner_id=client.owner_id,
                  payload={"payment_id": allocation.payment_id, "invoice_id": allocation.invoice_id})
    db.delete(allocation)
    db.flush()

    # Снимаем оплату — счёт снова становится «выставлен», долг возвращается.
    if invoice is not None:
        status_after = _sync_invoice_status(db, invoice)
        record_change(db, entity="invoice", entity_id=invoice.id, action=ACTION_UPSERT,
                      owner_id=client.owner_id,
                      payload={"status": status_after,
                               "allocated": _allocated_by_invoice(db, invoice.id)})
    db.commit()
    return {"status": "ok"}


@router.get("/clients/{client_id}/financial-summary", response_model=FinancialSummary)
def financial_summary(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    return _summary(db, client.id)


# ---------------------------------------------------------------- общая сводка
# Требования §7: п.79 общий раздел «Финансы», п.80 счётчики сверху,
# п.81 таблица счетов и платежей, п.82 долг из финансовых записей.
@router.get("/finance/overview")
def finance_overview(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Сводка по всем доступным клиентам + последние счета и платежи.

    Менеджер видит только своих клиентов, админ — всех. Суммы считаются
    по финансовым записям (Invoice/Payment/Allocation), не по заметкам AI.
    """
    from ..models import Client

    clients_q = select(Client).where(Client.deleted_at.is_(None), Client.type != PERSONAL_PLAN_TYPE)
    if user.role != "admin":
        clients_q = clients_q.where(Client.owner_id == user.id)
    clients = list(db.scalars(clients_q))
    client_ids = [c.id for c in clients]
    names = {c.id: c.name for c in clients}

    if not client_ids:
        return {
            "billed": 0.0, "paid": 0.0, "allocated": 0.0, "debt": 0.0,
            "overdue_amount": 0.0, "invoices": 0, "unpaid_invoices": 0,
            "clients": 0, "rows": [],
        }

    invoices = list(db.scalars(
        select(Invoice)
        .where(Invoice.client_id.in_(client_ids), Invoice.deleted_at.is_(None))
        .order_by(Invoice.issue_date.desc())
    ))
    payments = list(db.scalars(
        select(Payment)
        .where(Payment.client_id.in_(client_ids), Payment.deleted_at.is_(None))
        .order_by(Payment.paid_at.desc())
    ))
    invoice_ids = [i.id for i in invoices]
    alloc_by_invoice = _allocation_totals(db, invoice_ids)
    today = date.today()
    active_invoices = [i for i in invoices if i.status != "void"]
    billed = sum(float(i.amount or 0) for i in active_invoices)
    paid = sum(float(p.amount or 0) for p in payments)
    allocated = sum(alloc_by_invoice.values())
    overdue_amount = sum(
        _remaining(i, alloc_by_invoice) for i in invoices
        if i.status == "issued" and i.due_date and i.due_date < today
    )

    rows = []
    for invoice in invoices[:200]:
        if invoice.client_id not in names:
            continue
        amount = float(invoice.amount or 0)
        covered = alloc_by_invoice.get(invoice.id, 0.0)
        rows.append({
            "id": invoice.id,
            "client_id": invoice.client_id,
            "client_name": names.get(invoice.client_id),
            "number": invoice.number,
            "issue_date": invoice.issue_date,
            "due_date": invoice.due_date,
            "amount": round(amount, 2),
            "allocated": round(covered, 2),
            "remaining": _remaining(invoice, alloc_by_invoice),
            "status": invoice.status,
            "overdue": bool(invoice.status == "issued" and invoice.due_date and invoice.due_date < today),
        })

    return {
        "billed": round(billed, 2),
        "paid": round(paid, 2),
        "allocated": round(allocated, 2),
        "debt": round(billed - allocated, 2),
        "overdue_amount": round(overdue_amount, 2),
        "invoices": len(invoices),
        "unpaid_invoices": sum(1 for i in invoices if i.status == "issued"),
        "clients": len(clients),
        "rows": rows,
        "payments": [
            {
                "id": p.id,
                "client_id": p.client_id,
                "client_name": names.get(p.client_id),
                "amount": round(float(p.amount or 0), 2),
                "paid_at": p.paid_at,
                "method": getattr(p, "method", None),
            }
            for p in payments[:50]
        ],
    }
