"""Наполнение демо-данными при первом запуске (идемпотентно)."""
from __future__ import annotations

import os
import secrets
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Client,
    ClientContact,
    Invoice,
    Note,
    Payment,
    PaymentAllocation,
    Project,
    Task,
    User,
    utcnow,
)
from ..security import hash_password
from .importer import import_xlsx

GRISHANOV_FILENAME = "Отчетная таблица Гришанов к совещанию 16.11.2026.xlsx"
# Каталог с исходным XLSX не зашит в код: задаётся FORTEON_SEED_DIR,
# по умолчанию — рабочий стол текущего пользователя.
SEED_SOURCE_DIR = Path(os.getenv("FORTEON_SEED_DIR") or (Path.home() / "Desktop"))


def _generate_password(email: str) -> str:
    """Случайный пароль для bootstrap-учётки + запись в файл вне репозитория.

    Нужен, чтобы в исходниках не было ни одного пароля по умолчанию.
    Файл лежит в data/ (в .gitignore) и доступен только владельцу процесса.
    """
    password = secrets.token_urlsafe(15)
    target_dir = Path(settings.storage_dir).parent
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / "bootstrap-credentials.txt"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(f"{email}\t{password}\n")
        os.chmod(path, 0o600)
    except OSError:
        # Запись не удалась — пароль всё равно возвращаем, чтобы вход был возможен.
        pass
    return password


def ensure_user(db: Session, email: str, password: str, full_name: str, role: str,
                color: str = "#2455DB") -> User:
    user = db.scalar(select(User).where(User.email == email))
    if user:
        return user
    # Пароль из .env имеет приоритет; иначе генерируем и не храним в коде.
    password = password or _generate_password(email)
    user = User(
        email=email,
        password_hash=hash_password(password),
        full_name=full_name,
        role=role,
        timezone=settings.default_timezone,
        avatar_color=color,
    )
    db.add(user)
    db.flush()
    return user


def seed(db: Session) -> dict:
    """Создаёт администратора, менеджера и импортирует отчёт Гришанова при наличии файла."""
    result: dict = {"users": [], "import": None}

    admin = ensure_user(db, settings.bootstrap_admin_email, settings.bootstrap_admin_password,
                        "Администратор ForteOn", "admin", "#151B29")
    manager = ensure_user(db, settings.bootstrap_manager_email, settings.bootstrap_manager_password,
                          "Гришанов Сергей", "manager", "#2455DB")
    result["users"] = [admin.email, manager.email]
    db.flush()

    has_clients = db.scalar(
        select(Client).where(Client.owner_id == manager.id, Client.deleted_at.is_(None)).limit(1)
    )
    if has_clients is None:
        source: Path | None = None
        for candidate in (GRISHANOV_FILENAME, SEED_SOURCE_DIR / GRISHANOV_FILENAME):
            if isinstance(candidate, Path) and candidate.exists():
                source = candidate
                break
        if source is None:
            base = Path(settings.storage_dir).parent / "seed"
            matches = sorted(base.glob("*Гришанов*.xlsx")) if base.exists() else []
            if matches:
                source = matches[0]

        if source is not None:
            stats = import_xlsx(db, source, manager)
            result["import"] = {
                "source": source.name,
                "clients": stats.clients_created,
                "projects": stats.projects_created,
                "tasks": stats.tasks_created,
                "problems": stats.problems_created,
            }
        else:
            _seed_minimal(db, manager)
            result["import"] = {"source": "minimal-demo"}

    _seed_finance(db, manager)
    db.commit()
    return result


def _seed_minimal(db: Session, owner: User) -> None:
    demo = [
        ("ЭКСПОЦЕНТР сервис", "Москва", "в работе", 210000, 42000,
         "устранение уязвимостей", "документы за октябрь"),
        ("Океанариум Сочи", "Сочи", "переговоры", 2000000, None, "переговоры", "КП"),
        ("Байкальская Нерпа", "Иркутск", "договор", None, None,
         "договор", "Согласование договора с директором"),
    ]
    for name, location, status, revenue, volume, done, next_sprint in demo:
        client = Client(owner_id=owner.id, name=name, legal_name=name, address=location, status="active")
        db.add(client)
        db.flush()
        db.add(ClientContact(client_id=client.id, name="Основной контакт", is_primary=True))
        project = Project(
            client_id=client.id,
            name=name,
            location=location,
            status=status,
            start_date=date.today() - timedelta(days=120),
            volume=volume,
            planned_revenue=revenue,
            done_before=done,
            plan_next_sprint=next_sprint,
        )
        db.add(project)
        db.flush()
        db.add(
            Note(
                client_id=client.id,
                project_id=project.id,
                author_id=owner.id,
                body=f"{done}. Следующий спринт: {next_sprint}.",
                source_type="import",
                ai_status="imported",
                idempotency_key=f"seed:{name}",
                note_timezone=owner.timezone,
            )
        )
        db.add(
            Task(
                client_id=client.id,
                project_id=project.id,
                assignee_id=owner.id,
                title=next_sprint,
                type="other",
                priority="high",
                status="open",
                due_date=date.today() + timedelta(days=3),
                origin="import",
                timezone=owner.timezone,
            )
        )


def _seed_finance(db: Session, owner: User) -> None:
    clients = list(db.scalars(select(Client).where(Client.owner_id == owner.id).limit(4)))
    if not clients:
        return
    today = date.today()

    for index, client in enumerate(clients):
        existing = db.scalar(select(Invoice).where(Invoice.client_id == client.id).limit(1))
        if existing:
            continue
        project = db.scalar(select(Project).where(Project.client_id == client.id).limit(1))
        amount = [420000, 1250000, 300000, 780000][index % 4]
        invoice = Invoice(
            client_id=client.id,
            project_id=project.id if project else None,
            number=f"INV-2026-{100 + index}",
            issue_date=today - timedelta(days=40 - index * 5),
            due_date=today - timedelta(days=10 - index * 4),
            amount=amount,
            status="issued",
        )
        db.add(invoice)
        db.flush()

        paid = amount if index % 3 == 0 else int(amount * 0.4)
        payment = Payment(
            client_id=client.id,
            paid_at=today - timedelta(days=20 - index * 3),
            amount=paid,
            reference=f"ПП-{900 + index}",
        )
        db.add(payment)
        db.flush()
        db.add(PaymentAllocation(payment_id=payment.id, invoice_id=invoice.id, amount=paid))
        if paid >= amount:
            invoice.status = "paid"

        db.add(
            Task(
                client_id=client.id,
                project_id=project.id if project else None,
                assignee_id=owner.id,
                title="Проверить поступление оплаты по счёту" if paid < amount else "Направить закрывающие документы",
                type="payment" if paid < amount else "document",
                priority="high" if paid < amount else "normal",
                status="open",
                due_date=today + timedelta(days=2 + index),
                origin="manual",
                timezone=owner.timezone,
            )
        )
