"""Доменные модели ForteOn (раздел 06 спецификации).

Все основные сущности имеют UUID, created_at, updated_at, version.
Для удаляемых бизнес-записей — deleted_at. Время — в UTC.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_uuid() -> str:
    return str(uuid.uuid4())


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(32), default="manager", nullable=False)  # manager|admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Yekaterinburg", nullable=False)
    avatar_color: Mapped[str] = mapped_column(String(16), default="#2455DB", nullable=False)

    clients: Mapped[list["Client"]] = relationship(back_populates="owner")
    sessions: Mapped[list["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    refresh_token_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    device_label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(256), nullable=True)

    user: Mapped[User] = relationship(back_populates="sessions")


class UserAvatar(Base):
    __tablename__ = "user_avatars"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    image: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)


PERSONAL_PLAN_TYPE = "personal_plan"


class Client(Base, TimestampMixin):
    __tablename__ = "clients"
    __table_args__ = (Index("ix_clients_owner_status", "owner_id", "status"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    type: Mapped[str] = mapped_column(String(16), default="legal", nullable=False)  # legal|individual
    name: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    legal_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    tax_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    registration_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    address: Mapped[str | None] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    notes_public: Mapped[str | None] = mapped_column(Text, nullable=True)

    owner: Mapped[User] = relationship(back_populates="clients")
    contacts: Mapped[list["ClientContact"]] = relationship(back_populates="client", cascade="all, delete-orphan")
    projects: Mapped[list["Project"]] = relationship(back_populates="client", cascade="all, delete-orphan")
    contracts: Mapped[list["Contract"]] = relationship(back_populates="client", cascade="all, delete-orphan")
    notes: Mapped[list["Note"]] = relationship(back_populates="client", cascade="all, delete-orphan")
    tasks: Mapped[list["Task"]] = relationship(back_populates="client", cascade="all, delete-orphan")


class ClientContact(Base, TimestampMixin):
    __tablename__ = "client_contacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    position: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    client: Mapped[Client] = relationship(back_populates="contacts")


class Project(Base, TimestampMixin):
    __tablename__ = "projects"
    __table_args__ = (Index("ix_projects_client", "client_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    location: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(64), default="new", nullable=False)
    stage_group: Mapped[str | None] = mapped_column(String(128), nullable=True)
    start_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    planned_revenue: Mapped[float | None] = mapped_column(Numeric(16, 2), nullable=True)
    estimated_cost: Mapped[float | None] = mapped_column(Numeric(16, 2), nullable=True)
    volume: Mapped[float | None] = mapped_column(Numeric(16, 2), nullable=True)
    service_flag: Mapped[str | None] = mapped_column(String(64), nullable=True)
    done_before: Mapped[str | None] = mapped_column(Text, nullable=True)
    done_last_sprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    plan_next_sprint: Mapped[str | None] = mapped_column(Text, nullable=True)
    problems_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    meeting_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_row: Mapped[int | None] = mapped_column(Integer, nullable=True)

    client: Mapped[Client] = relationship(back_populates="projects")
    modules: Mapped[list["ProjectModule"]] = relationship(back_populates="project", cascade="all, delete-orphan")

    @property
    def expected_profit(self) -> Decimal | None:
        if self.planned_revenue is None or self.estimated_cost is None:
            return None
        return Decimal(str(self.planned_revenue)) - Decimal(str(self.estimated_cost))


class ProjectModule(Base, TimestampMixin):
    __tablename__ = "project_modules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="planned", nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    project: Mapped[Project] = relationship(back_populates="modules")


class Contract(Base, TimestampMixin):
    __tablename__ = "contracts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    number: Mapped[str | None] = mapped_column(String(128), nullable=True)
    signed_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    starts_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    ends_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    amount: Mapped[float | None] = mapped_column(Numeric(16, 2), nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="RUB", nullable=False)

    client: Mapped[Client] = relationship(back_populates="contracts")


class Note(Base, TimestampMixin):
    __tablename__ = "notes"
    __table_args__ = (Index("ix_notes_client_created", "client_id", "created_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"))
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    author_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    source_type: Mapped[str] = mapped_column(String(16), default="text", nullable=False)  # text|voice|import
    ai_status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)  # pending|queued|ok|failed
    ai_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)
    note_timezone: Mapped[str] = mapped_column(String(64), default="Asia/Yekaterinburg", nullable=False)

    client: Mapped[Client] = relationship(back_populates="notes")
    tasks: Mapped[list["Task"]] = relationship(back_populates="source_note")


class AIRun(Base):
    __tablename__ = "ai_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    note_id: Mapped[str] = mapped_column(ForeignKey("notes.id", ondelete="CASCADE"), index=True)
    model: Mapped[str] = mapped_column(String(128), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(16), default="v1", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="ok", nullable=False)
    tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"
    __table_args__ = (Index("ix_tasks_assignee_due", "assignee_id", "due_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    assignee_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    source_note_id: Mapped[str | None] = mapped_column(ForeignKey("notes.id", ondelete="SET NULL"), nullable=True)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    type: Mapped[str] = mapped_column(String(32), default="call", nullable=False)
    priority: Mapped[str] = mapped_column(String(16), default="normal", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="open", nullable=False)  # open|done|cancelled
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Yekaterinburg", nullable=False)
    origin: Mapped[str] = mapped_column(String(16), default="manual", nullable=False)  # manual|ai|import
    source_quote: Mapped[str | None] = mapped_column(Text, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    conditional: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    review_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Конкретный вопрос менеджеру при уточнении (п.14): не «уточните»,
    # а «документ уже отправлен или его ещё нужно подготовить?»
    review_question: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Тип события (events.py): todo | waiting | unclear.
    # done и fact задачами не становятся — они уходят в историю заметки.
    event_kind: Mapped[str] = mapped_column(String(16), default="todo", nullable=False)
    # Кто действует: us (мы) или client (ждём от клиента).
    # Нужно, чтобы отделять обязательства клиента от наших задач (п.8).
    actor: Mapped[str] = mapped_column(String(16), default="us", nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    result_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    dedupe_key: Mapped[str | None] = mapped_column(String(128), index=True, nullable=True)

    client: Mapped[Client] = relationship(back_populates="tasks")
    source_note: Mapped[Note | None] = relationship(back_populates="tasks")
    commitments: Mapped[list["Commitment"]] = relationship(back_populates="related_task")


class Commitment(Base, TimestampMixin):
    __tablename__ = "commitments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    related_task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True)
    promised_by: Mapped[str] = mapped_column(String(32), default="client", nullable=False)  # client|us
    description: Mapped[str] = mapped_column(Text, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="open", nullable=False)  # open|fulfilled|broken|cancelled
    source_quote: Mapped[str | None] = mapped_column(Text, nullable=True)

    related_task: Mapped[Task | None] = relationship(back_populates="commitments")


class Invoice(Base, TimestampMixin):
    __tablename__ = "invoices"
    __table_args__ = (Index("ix_invoices_client_due", "client_id", "due_date"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"))
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    issue_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2), default=0, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), default="RUB", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="issued", nullable=False)  # draft|issued|paid|void


class Payment(Base, TimestampMixin):
    __tablename__ = "payments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    paid_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2), default=0, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), default="RUB", nullable=False)
    reference: Mapped[str | None] = mapped_column(String(128), nullable=True)


class PaymentAllocation(Base):
    __tablename__ = "payment_allocations"
    __table_args__ = (UniqueConstraint("payment_id", "invoice_id", name="uq_alloc_payment_invoice"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    payment_id: Mapped[str] = mapped_column(ForeignKey("payments.id", ondelete="CASCADE"), index=True)
    invoice_id: Mapped[str] = mapped_column(ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    amount: Mapped[float] = mapped_column(Numeric(16, 2), default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class Document(Base, TimestampMixin):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    contract_id: Mapped[str | None] = mapped_column(ForeignKey("contracts.id", ondelete="SET NULL"), nullable=True)
    storage_key: Mapped[str] = mapped_column(String(512), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    checksum: Mapped[str | None] = mapped_column(String(64), nullable=True)
    uploaded_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), nullable=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    channel: Mapped[str] = mapped_column(String(16), default="in_app", nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)


class ClientTransfer(Base):
    __tablename__ = "client_transfers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    client_id: Mapped[str] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"), index=True)
    from_user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    to_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    transferred_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    transferred_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)


class SyncOperation(Base):
    __tablename__ = "sync_operations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    operation_id: Mapped[str] = mapped_column(String(36), unique=True, index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    base_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    result: Mapped[str] = mapped_column(String(16), default="applied", nullable=False)
    payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)


class ChangeLog(Base):
    __tablename__ = "change_log"

    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(16), nullable=False)  # upsert|delete|tombstone
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)


class ReportJob(Base):
    __tablename__ = "report_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    requested_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    format: Mapped[str] = mapped_column(String(8), default="pdf", nullable=False)  # pdf|xlsx
    scope: Mapped[str] = mapped_column(String(16), default="all", nullable=False)  # all|client
    client_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    filters_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    file_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
