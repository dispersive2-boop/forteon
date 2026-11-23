"""п.15 «30 идей»: договор связан со счётом и файлом.

Почему именно так
-----------------
В карточке проекта был только номер договора и сумма. Менеджер не мог
ответить ни на «этот договор оплачен?», ни на «где подписанный скан».
Теперь договор ссылается на счёт (и видит, сколько по нему зачтено) и на
файл в документах клиента.

Проверяем поведение:
  * договор принимает счёт и файл;
  * ответ сразу говорит, сколько зачтено по счёту;
  * чужой счёт привязать нельзя — иначе через подмену id видно чужую сумму;
  * чужой файл тоже нельзя;
  * договор без счёта по-прежнему работает.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings as _settings

assert "forteon_test" in _settings.database_url

from app.db import Base, engine, get_db  # noqa: E402
from app.deps import get_current_user  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (
    Client,
    Document,
    Invoice,
    Payment,
    PaymentAllocation,
    Project,
    User,
)  # noqa: E402
from app.security import hash_password  # noqa: E402

USER_ID = "contract-user-0000-0000-0000-000000000001"
OTHER_ID = "contract-user-0000-0000-0000-000000000002"
CLIENT_ID = "contract-client-0000-0000-0000-000000001"
FOREIGN_CLIENT_ID = "contract-client-0000-0000-0000-000000002"
PROJECT_ID = "contract-project-0000-0000-0000-00000001"
INVOICE_ID = "contract-invoice-0000-0000-0000-0000001"
FOREIGN_INVOICE_ID = "contract-invoice-0000-0000-0000-0000002"
PAYMENT_ID = "contract-payment-0000-0000-0000-0000001"
DOCUMENT_ID = "contract-document-0000-0000-0000-0000001"
FOREIGN_DOCUMENT_ID = "contract-document-0000-0000-0000-0000002"


@pytest.fixture()
def db() -> Iterator[Session]:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)()
    # Пользователи — отдельным коммитом: у Client.owner_id нет relationship,
    # поэтому SQLAlchemy не знает, что users надо вставлять первыми, и
    # падает на внешнем ключе.
    session.add_all([
        User(id=USER_ID, email="c1@forteon.local", full_name="Менеджер Один",
             password_hash=hash_password("Contracts-pass-1"), role="manager", is_active=True),
        User(id=OTHER_ID, email="c2@forteon.local", full_name="Менеджер Два",
             password_hash=hash_password("Contracts-pass-2"), role="manager", is_active=True),
    ])
    session.commit()

    session.add_all([
        Client(id=CLIENT_ID, name="Свой клиент", owner_id=USER_ID, status="active"),
        Client(id=FOREIGN_CLIENT_ID, name="Чужой клиент", owner_id=OTHER_ID, status="active"),
    ])
    session.commit()

    session.add(Project(id=PROJECT_ID, client_id=CLIENT_ID, name="Объект", status="active"))
    session.commit()

    session.add_all([
        Invoice(
            id=INVOICE_ID, client_id=CLIENT_ID, project_id=PROJECT_ID, number="С-17",
            amount=500000, status="issued", issue_date=date(2026, 11, 1),
            due_date=date(2026, 11, 30),
        ),
        Invoice(
            id=FOREIGN_INVOICE_ID, client_id=FOREIGN_CLIENT_ID, number="Ч-1",
            amount=999999, status="issued",
        ),
        Payment(id=PAYMENT_ID, client_id=CLIENT_ID, amount=200000, paid_at=date(2026, 11, 20)),
    ])
    session.commit()

    session.add_all([
        PaymentAllocation(id="contract-alloc-0000-0000-0000-000000001",
                          payment_id=PAYMENT_ID, invoice_id=INVOICE_ID, amount=200000),
        Document(id=DOCUMENT_ID, client_id=CLIENT_ID, filename="dogovor.pdf",
                 storage_key="dogovor.pdf", mime_type="application/pdf", size=1024),
        Document(id=FOREIGN_DOCUMENT_ID, client_id=FOREIGN_CLIENT_ID, filename="чужой.pdf",
                 storage_key="chuzhoy.pdf", mime_type="application/pdf", size=2048),
    ])
    session.commit()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def api(db: Session) -> Iterator[TestClient]:
    def _db() -> Iterator[Session]:
        yield db

    def _user() -> User:
        return db.get(User, USER_ID)

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_contract_without_invoice_still_works(api: TestClient) -> None:
    response = api.post(f"/api/v1/clients/{CLIENT_ID}/contracts", json={
        "number": "Б-1", "project_id": PROJECT_ID, "amount": 100000,
    })
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["invoice_id"] is None
    assert data["invoice_paid"] is None


def test_contract_links_invoice_and_shows_paid(api: TestClient) -> None:
    response = api.post(f"/api/v1/clients/{CLIENT_ID}/contracts", json={
        "number": "С-17/д", "project_id": PROJECT_ID, "amount": 500000,
        "invoice_id": INVOICE_ID,
    })
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["invoice_id"] == INVOICE_ID
    assert data["invoice_number"] == "С-17"
    assert data["invoice_paid"] == 200000.0, "Зачтено 200 000 из оплаты"


def test_contract_rejects_foreign_invoice(api: TestClient) -> None:
    response = api.post(f"/api/v1/clients/{CLIENT_ID}/contracts", json={
        "number": "Х-1", "invoice_id": FOREIGN_INVOICE_ID,
    })
    assert response.status_code == 400, "Чужой счёт привязывать нельзя"
    # http_exception_handler в main.py разворачивает detail в корень ответа.
    assert response.json()["code"] == "invalid_invoice"


def test_attach_document_to_contract(api: TestClient) -> None:
    contract = api.post(f"/api/v1/clients/{CLIENT_ID}/contracts", json={"number": "Ф-1"}).json()
    assert contract["documents"] == []

    attached = api.post(f"/api/v1/contracts/{contract['id']}/documents/{DOCUMENT_ID}")
    assert attached.status_code == 200, attached.text
    data = attached.json()
    assert len(data["documents"]) == 1
    assert data["documents"][0]["filename"] == "dogovor.pdf"

    listed = api.get(f"/api/v1/clients/{CLIENT_ID}/contracts").json()
    assert listed[0]["documents"][0]["id"] == DOCUMENT_ID


def test_attach_rejects_foreign_document(api: TestClient) -> None:
    contract = api.post(f"/api/v1/clients/{CLIENT_ID}/contracts", json={"number": "Ф-2"}).json()
    response = api.post(f"/api/v1/contracts/{contract['id']}/documents/{FOREIGN_DOCUMENT_ID}")
    assert response.status_code == 400, "Чужой файл прикреплять нельзя"
    assert response.json()["code"] == "invalid_document"


def test_contract_list_includes_paid(api: TestClient) -> None:
    api.post(f"/api/v1/clients/{CLIENT_ID}/contracts", json={
        "number": "С-17/д", "invoice_id": INVOICE_ID,
    })
    rows = api.get(f"/api/v1/clients/{CLIENT_ID}/contracts").json()
    assert len(rows) == 1
    assert rows[0]["invoice_paid"] == 200000.0
    assert rows[0]["invoice_number"] == "С-17"
