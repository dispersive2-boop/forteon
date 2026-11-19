"""Финансы: счета, оплаты, распределения (раздел 10).

Долг = выставлено по действующим счетам − распределённые оплаты.
Плановый доход проекта прибылью не является.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, get_client_or_404, get_current_user
from ..models import Invoice, Payment, PaymentAllocation, User, utcnow
from ..schemas import (
    AllocationIn,
    FinancialSummary,
    InvoiceCreate,
    InvoiceOut,
    PaymentCreate,
    PaymentOut,
)

router = APIRouter(tags=["finance"])


def _summary(db: Session, client_id: str) -> FinancialSummary:
    invoices = list(db.scalars(select(Invoice).where(Invoice.client_id == client_id)))
    payments = list(db.scalars(select(Payment).where(Payment.client_id == client_id)))
    invoice_ids = [i.id for i in invoices]
    allocations = list(
        db.scalars(select(PaymentAllocation).where(PaymentAllocation.invoice_id.in_(invoice_ids or ["-"])))
    )

    billed = sum(float(i.amount or 0) for i in invoices if i.status != "void")
    paid = sum(float(p.amount or 0) for p in payments)
    allocated = sum(float(a.amount or 0) for a in allocations)
    today = date.today()
    overdue_amount = sum(
        float(i.amount or 0) for i in invoices
        if i.status in ("issued",) and i.due_date and i.due_date < today
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
    rows = db.scalars(
        select(Invoice).where(Invoice.client_id == client.id, Invoice.deleted_at.is_(None))
        .order_by(Invoice.due_date.desc())
    )
    return [InvoiceOut.model_validate(i) for i in rows]


@router.post("/clients/{client_id}/invoices", response_model=InvoiceOut, status_code=201)
def create_invoice(client_id: str, payload: InvoiceCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    invoice = Invoice(client_id=client.id, **payload.model_dump())
    db.add(invoice)
    db.flush()
    audit(db, user, "invoice", invoice.id, "created", {"amount": payload.amount, "currency": payload.currency})
    db.commit()
    db.refresh(invoice)
    return InvoiceOut.model_validate(invoice)


@router.patch("/invoices/{invoice_id}", response_model=InvoiceOut)
def update_invoice(invoice_id: str, payload: InvoiceCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    invoice = db.get(Invoice, invoice_id)
    if invoice is None or invoice.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Счёт не найден"})
    get_client_or_404(db, user, invoice.client_id)
    # Финансы не перезаписываются молча: изменение фиксируется в аудите
    before = {"amount": float(invoice.amount or 0), "status": invoice.status}
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(invoice, key, value)
    invoice.version = (invoice.version or 1) + 1
    audit(db, user, "invoice", invoice.id, "updated",
          {"before": before, "after": {"amount": float(invoice.amount or 0), "status": invoice.status}})
    db.commit()
    db.refresh(invoice)
    return InvoiceOut.model_validate(invoice)


@router.post("/clients/{client_id}/payments", response_model=PaymentOut, status_code=201)
def create_payment(client_id: str, payload: PaymentCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    payment = Payment(client_id=client.id, **payload.model_dump())
    db.add(payment)
    db.flush()
    audit(db, user, "payment", payment.id, "created", {"amount": payload.amount})
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


@router.post("/payments/{payment_id}/allocations")
def create_allocation(payment_id: str, payload: AllocationIn, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    payment = db.get(Payment, payment_id)
    if payment is None or payment.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Оплата не найдена"})
    get_client_or_404(db, user, payment.client_id)

    invoice = db.get(Invoice, payload.invoice_id)
    if invoice is None or invoice.client_id != payment.client_id:
        raise HTTPException(status_code=400, detail={"code": "bad_invoice", "message": "Счёт не относится к клиенту"})
    if payload.amount <= 0:
        raise HTTPException(status_code=400, detail={"code": "bad_amount", "message": "Сумма должна быть больше нуля"})

    allocated_total = db.scalar(
        select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(PaymentAllocation.payment_id == payment.id)
    ) or 0
    if float(allocated_total) + payload.amount > float(payment.amount or 0) + 0.01:
        raise HTTPException(
            status_code=400,
            detail={"code": "over_allocation", "message": "Распределение превышает сумму оплаты"},
        )

    allocation = PaymentAllocation(payment_id=payment.id, invoice_id=invoice.id, amount=payload.amount)
    db.add(allocation)

    invoice_allocated = db.scalar(
        select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(PaymentAllocation.invoice_id == invoice.id)
    ) or 0
    if float(invoice_allocated) + payload.amount >= float(invoice.amount or 0) - 0.01:
        invoice.status = "paid"

    audit(db, user, "allocation", allocation.id, "created",
          {"payment_id": payment.id, "invoice_id": invoice.id, "amount": payload.amount})
    db.commit()
    return {
        "id": allocation.id,
        "payment_id": allocation.payment_id,
        "invoice_id": allocation.invoice_id,
        "amount": float(allocation.amount),
    }


@router.delete("/payment-allocations/{allocation_id}")
def delete_allocation(allocation_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    allocation = db.get(PaymentAllocation, allocation_id)
    if allocation is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Распределение не найдено"})
    payment = db.get(Payment, allocation.payment_id)
    if payment is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Оплата не найдена"})
    get_client_or_404(db, user, payment.client_id)
    audit(db, user, "allocation", allocation.id, "deleted", {"amount": float(allocation.amount)})
    db.delete(allocation)
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

    clients_q = select(Client).where(Client.deleted_at.is_(None))
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
        select(Invoice).where(Invoice.client_id.in_(client_ids)).order_by(Invoice.issue_date.desc())
    ))
    payments = list(db.scalars(
        select(Payment).where(Payment.client_id.in_(client_ids)).order_by(Payment.paid_at.desc())
    ))
    invoice_ids = [i.id for i in invoices]
    allocations = list(db.scalars(
        select(PaymentAllocation).where(PaymentAllocation.invoice_id.in_(invoice_ids or ["-"]))
    )) if invoice_ids else []

    today = date.today()
    active_invoices = [i for i in invoices if i.status != "void"]
    billed = sum(float(i.amount or 0) for i in active_invoices)
    paid = sum(float(p.amount or 0) for p in payments)
    allocated = sum(float(a.amount or 0) for a in allocations)
    overdue_amount = sum(
        float(i.amount or 0) for i in invoices
        if i.status == "issued" and i.due_date and i.due_date < today
    )

    # Распределено по каждому счёту — чтобы показать остаток в строке.
    alloc_by_invoice: dict[str, float] = {}
    for alloc in allocations:
        alloc_by_invoice[alloc.invoice_id] = alloc_by_invoice.get(alloc.invoice_id, 0.0) + float(alloc.amount or 0)

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
            "remaining": round(max(amount - covered, 0.0), 2),
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
