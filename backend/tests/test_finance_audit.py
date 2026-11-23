"""A-P0-2: сохранность денежных данных.

Проверяем поведение, а не наличие кода:
  * каждая денежная операция оставляет запись в `audit_log`;
  * статус счёта следует за распределениями в обе стороны;
  * счёт с распределённой оплатой нельзя удалить;
  * удалённый счёт выпадает из долга;
  * история клиента отдаёт денежные события;
  * операции попадают в `change_log` — иначе офлайн-клиент не синхронизируется.
"""
from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

# Отдельная БД — тест не должен трогать рабочую.
#
# Настройка окружения живёт в tests/conftest.py, потому что pytest импортирует
# все тестовые модули ДО запуска первого теста: два модуля, каждый со своим
# FORTEON_DATABASE_URL, затирали друг друга и валили сборку. Раньше здесь
# стояло DATABASE_URL без префикса FORTEON_ — приложение его не видело и
# тест работал с БОЕВОЙ базой: фикстура db() делает drop_all()+create_all(),
# поэтому каждый прогон pytest стирал рабочую БД вместе с клиентами и задачами.
#
# Страховка: если по какой-то причине окружение не подхватилось — падаем
# сразу, а не после drop_all() по рабочей базе.
from app.config import settings as _settings  # noqa: E402

assert "forteon_test" in _settings.database_url, (
    "Тест подключён к боевой БД (%s). Проверьте tests/conftest.py."
    % _settings.database_url
)

from app import models  # noqa: E402
from app.api import finance as finance_api  # noqa: E402
from app.db import Base, engine, get_db  # noqa: E402
from app.deps import get_current_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (  # noqa: E402
    AuditLog,
    ChangeLog,
    Client,
    Invoice,
    Payment,
    PaymentAllocation,
    User,
)
from app.security import hash_password  # noqa: E402

USER_ID = "test-user-0000-0000-0000-000000000001"
CLIENT_ID = "test-client-0000-0000-0000-00000000001"


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    user = User(
        id=USER_ID,
        email="tester@forteon.local",
        full_name="Тестировщик",
        password_hash=hash_password("Test-pass-123"),
        role="manager",
        is_active=True,
    )
    client = Client(id=CLIENT_ID, name="Тестовый клиент", owner_id=USER_ID, status="active")
    session.add_all([user, client])
    session.commit()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def api(db: Session) -> Iterator[TestClient]:
    def _db_override() -> Iterator[Session]:
        yield db

    def _user_override() -> User:
        return db.get(User, USER_ID)

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _user_override
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _create_invoice(api: TestClient, amount: float = 5000) -> dict:
    resp = api.post(f"/api/v1/clients/{CLIENT_ID}/invoices",
                    json={"amount": amount, "number": "T-1", "status": "issued"})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_payment(api: TestClient, amount: float = 5000) -> dict:
    resp = api.post(f"/api/v1/clients/{CLIENT_ID}/payments", json={"amount": amount})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_money_operations_are_audited(api: TestClient, db: Session) -> None:
    invoice = _create_invoice(api)
    payment = _create_payment(api)
    alloc = api.post(f"/api/v1/payments/{payment['id']}/allocations",
                     json={"invoice_id": invoice["id"], "amount": 5000})
    assert alloc.status_code == 200, alloc.text

    rows = list(db.scalars(select(AuditLog).order_by(AuditLog.created_at)))
    actions = {(r.entity, r.action) for r in rows}
    assert ("invoice", "created") in actions
    assert ("payment", "created") in actions
    assert ("allocation", "created") in actions
    # Событие зачёта пишется на счёт: распределение удаляется физически.
    assert ("invoice", "allocation_added") in actions

    meta = json.loads(next(r.metadata_json for r in rows if r.action == "created"
                           and r.entity == "payment"))
    assert meta["amount"] == 5000.0
    assert all(r.actor_id == USER_ID for r in rows)


def test_invoice_status_follows_allocations(api: TestClient, db: Session) -> None:
    invoice = _create_invoice(api)
    payment = _create_payment(api)

    alloc = api.post(f"/api/v1/payments/{payment['id']}/allocations",
                     json={"invoice_id": invoice["id"], "amount": 5000})
    assert alloc.json()["invoice_status"] == "paid"
    assert db.get(Invoice, invoice["id"]).status == "paid"

    removed = api.delete(f"/api/v1/payment-allocations/{alloc.json()['id']}")
    assert removed.status_code == 200, removed.text
    # Раньше статус оставался «оплаченным» и долг был занижен.
    assert db.get(Invoice, invoice["id"]).status == "issued"

    actions = {r.action for r in db.scalars(select(AuditLog).where(AuditLog.entity == "invoice"))}
    assert "allocation_removed" in actions


def test_partial_allocation_does_not_mark_paid(api: TestClient, db: Session) -> None:
    invoice = _create_invoice(api, amount=10000)
    payment = _create_payment(api, amount=4000)
    alloc = api.post(f"/api/v1/payments/{payment['id']}/allocations",
                     json={"invoice_id": invoice["id"], "amount": 4000})
    assert alloc.status_code == 200
    assert db.get(Invoice, invoice["id"]).status == "issued"


def test_over_allocation_is_rejected(api: TestClient) -> None:
    invoice = _create_invoice(api, amount=10000)
    payment = _create_payment(api, amount=1000)
    resp = api.post(f"/api/v1/payments/{payment['id']}/allocations",
                    json={"invoice_id": invoice["id"], "amount": 5000})
    assert resp.status_code == 400
    # Ошибки API плоские: {code, message, details, request_id}.
    # Фолбэк на "detail" оставлен для совместимости с прежним форматом.
    payload = resp.json()
    error = payload.get("detail", payload)
    assert error["code"] == "over_allocation"
    assert error["details"]["already_allocated"] == 0.0


def test_invoice_with_payment_cannot_be_deleted(api: TestClient) -> None:
    invoice = _create_invoice(api)
    payment = _create_payment(api)
    api.post(f"/api/v1/payments/{payment['id']}/allocations",
             json={"invoice_id": invoice["id"], "amount": 5000})

    resp = api.delete(f"/api/v1/invoices/{invoice['id']}")
    assert resp.status_code == 409
    payload = resp.json()
    error = payload.get("detail", payload)
    assert error["code"] == "invoice_has_allocations"


def test_deleted_invoice_leaves_debt(api: TestClient, db: Session) -> None:
    invoice = _create_invoice(api, amount=7000)
    before = api.get(f"/api/v1/clients/{CLIENT_ID}/financial-summary").json()
    assert before["billed"] == 7000.0
    assert before["debt"] == 7000.0

    assert api.delete(f"/api/v1/invoices/{invoice['id']}").status_code == 200
    after = api.get(f"/api/v1/clients/{CLIENT_ID}/financial-summary").json()
    assert after["billed"] == 0.0
    assert after["debt"] == 0.0


def test_client_history_contains_money(api: TestClient, db: Session) -> None:
    invoice = _create_invoice(api)
    payment = _create_payment(api)
    alloc = api.post(f"/api/v1/payments/{payment['id']}/allocations",
                     json={"invoice_id": invoice["id"], "amount": 5000})
    api.delete(f"/api/v1/payment-allocations/{alloc.json()['id']}")

    resp = api.get(f"/api/v1/clients/{CLIENT_ID}/history")
    assert resp.status_code == 200, resp.text
    actions = {f"{i['entity']}:{i['action']}" for i in resp.json()["items"]}
    assert "invoice:created" in actions
    assert "payment:created" in actions
    assert "invoice:allocation_added" in actions
    assert "invoice:allocation_removed" in actions

    assert {i["actor"] for i in resp.json()["items"]} == {"Тестировщик"}


def test_changes_are_recorded_for_sync(api: TestClient, db: Session) -> None:
    invoice = _create_invoice(api)
    payment = _create_payment(api)
    api.post(f"/api/v1/payments/{payment['id']}/allocations",
             json={"invoice_id": invoice["id"], "amount": 5000})

    rows = list(db.scalars(select(ChangeLog)))
    entities = {r.entity for r in rows}
    assert {"invoice", "payment", "allocation"} <= entities
    assert all(r.owner_id == USER_ID for r in rows), "владелец нужен для /sync/pull"
    assert any(r.action == "upsert" for r in rows)


def test_payment_can_allocate_in_one_transaction(api: TestClient) -> None:
    invoice = _create_invoice(api, 100.50)
    path = f"/api/v1/clients/{CLIENT_ID}/payments"

    refused = api.post(path, json={"invoice_id": invoice["id"], "amount": 100.51})
    assert refused.status_code == 422
    assert api.get(path).json() == []

    accepted = api.post(path, json={"invoice_id": invoice["id"], "amount": 100.49})
    assert accepted.status_code == 201
    updated = api.get(f"/api/v1/clients/{CLIENT_ID}/invoices").json()[0]
    assert updated["status"] == "issued"
    assert updated["remaining"] == 0.01

    last_cent = api.post(path, json={"invoice_id": invoice["id"], "amount": 0.01})
    assert last_cent.status_code == 201
    updated = api.get(f"/api/v1/clients/{CLIENT_ID}/invoices").json()[0]
    assert updated["status"] == "paid"
    assert updated["remaining"] == 0
