"""Pydantic-схемы API v1."""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- auth
class LoginRequest(BaseModel):
    email: str
    password: str = Field(min_length=1, max_length=256)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: "UserOut"


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=256)


class UserOut(ORMModel):
    id: str
    email: str
    full_name: str
    role: str
    is_active: bool
    timezone: str
    avatar_color: str
    created_at: datetime | None = None


class UserCreate(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=256)
    full_name: str
    role: Literal["manager", "admin"] = "manager"
    timezone: str | None = None


class UserUpdate(BaseModel):
    full_name: str | None = None
    role: Literal["manager", "admin"] | None = None
    is_active: bool | None = None
    timezone: str | None = None
    password: str | None = Field(default=None, min_length=8, max_length=256)


class SessionOut(ORMModel):
    id: str
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    device_label: str | None
    user_agent: str | None


# ---------------------------------------------------------------- clients
class ContactIn(BaseModel):
    name: str
    position: str | None = None
    phone: str | None = None
    email: str | None = None
    is_primary: bool = False


class ContactOut(ORMModel):
    id: str
    client_id: str
    name: str
    position: str | None
    phone: str | None
    email: str | None
    is_primary: bool


class ClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    type: Literal["legal", "individual"] = "legal"
    legal_name: str | None = None
    tax_id: str | None = None
    registration_id: str | None = None
    address: str | None = None
    status: str = "active"
    notes_public: str | None = None
    contacts: list[ContactIn] = Field(default_factory=list)


class ClientUpdate(BaseModel):
    name: str | None = None
    type: Literal["legal", "individual"] | None = None
    legal_name: str | None = None
    tax_id: str | None = None
    registration_id: str | None = None
    address: str | None = None
    status: str | None = None
    notes_public: str | None = None
    version: int | None = None


class ClientOut(ORMModel):
    id: str
    owner_id: str
    type: str
    name: str
    legal_name: str | None
    tax_id: str | None
    registration_id: str | None
    address: str | None
    status: str
    notes_public: str | None
    version: int
    created_at: datetime
    updated_at: datetime


class ClientDetailOut(ClientOut):
    contacts: list[ContactOut] = Field(default_factory=list)
    projects_count: int = 0
    open_tasks: int = 0
    overdue_tasks: int = 0
    debt: float = 0.0


class PagedClients(BaseModel):
    items: list[ClientOut]
    next_cursor: str | None = None
    total: int


# ---------------------------------------------------------------- projects
class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    location: str | None = None
    status: str = "new"
    stage_group: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    planned_revenue: float | None = None
    estimated_cost: float | None = None
    volume: float | None = None
    service_flag: str | None = None
    done_before: str | None = None
    done_last_sprint: str | None = None
    plan_next_sprint: str | None = None
    problems_text: str | None = None
    meeting_comment: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    location: str | None = None
    status: str | None = None
    stage_group: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    planned_revenue: float | None = None
    estimated_cost: float | None = None
    volume: float | None = None
    service_flag: str | None = None
    done_before: str | None = None
    done_last_sprint: str | None = None
    plan_next_sprint: str | None = None
    problems_text: str | None = None
    meeting_comment: str | None = None
    version: int | None = None


class ProjectOut(ORMModel):
    id: str
    client_id: str
    name: str
    location: str | None
    status: str
    stage_group: str | None
    start_date: date | None
    end_date: date | None
    planned_revenue: float | None
    estimated_cost: float | None
    volume: float | None
    service_flag: str | None
    done_before: str | None
    done_last_sprint: str | None
    plan_next_sprint: str | None
    problems_text: str | None
    meeting_comment: str | None
    version: int


# ---------------------------------------------------------------- contracts
class ContractCreate(BaseModel):
    number: str | None = None
    project_id: str | None = None
    signed_at: date | None = None
    starts_at: date | None = None
    ends_at: date | None = None
    amount: float | None = None
    currency: str = "RUB"


class ContractOut(ORMModel):
    id: str
    client_id: str
    project_id: str | None
    number: str | None
    signed_at: date | None
    starts_at: date | None
    ends_at: date | None
    amount: float | None
    currency: str


# ---------------------------------------------------------------- notes & AI
class NoteCreate(BaseModel):
    body: str = Field(min_length=1)
    project_id: str | None = None
    source_type: Literal["text", "voice", "import"] = "text"
    idempotency_key: str | None = None
    timezone: str | None = None
    run_ai: bool = True


class NoteUpdate(BaseModel):
    body: str | None = None
    version: int | None = None


class NoteOut(ORMModel):
    id: str
    client_id: str
    project_id: str | None
    author_id: str
    body: str
    source_type: str
    ai_status: str
    ai_error: str | None
    created_at: datetime
    version: int


class AIStatusOut(BaseModel):
    note_id: str
    ai_status: str
    ai_error: str | None = None
    runs: list[dict[str, Any]] = Field(default_factory=list)
    tasks_created: int = 0
    commitments_created: int = 0
    needs_review: list[dict[str, Any]] = Field(default_factory=list)


class TranscriptRequest(BaseModel):
    text: str = Field(min_length=1, description="Результат STT-сервиса; в MVP передаётся клиентом")
    client_id: str | None = None


# ---------------------------------------------------------------- tasks
class TaskCreate(BaseModel):
    client_id: str
    project_id: str | None = None
    title: str = Field(min_length=1, max_length=512)
    description: str | None = None
    type: str = "call"
    priority: Literal["low", "normal", "high", "critical"] = "normal"
    due_at: datetime | None = None
    due_date: date | None = None
    timezone: str | None = None
    conditional: bool = False


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    type: str | None = None
    priority: str | None = None
    due_at: datetime | None = None
    due_date: date | None = None
    version: int | None = None


class TaskComplete(BaseModel):
    result_note: str | None = None


class TaskReschedule(BaseModel):
    due_at: datetime | None = None
    due_date: date | None = None
    reason: str | None = None


class TaskOut(ORMModel):
    id: str
    client_id: str
    client_name: str | None = None
    project_id: str | None
    assignee_id: str
    source_note_id: str | None
    title: str
    description: str | None
    type: str
    priority: str
    status: str
    due_at: datetime | None
    due_date: date | None
    timezone: str
    origin: str
    source_quote: str | None
    confidence: float | None
    conditional: bool
    needs_review: bool
    review_reason: str | None
    completed_at: datetime | None
    result_note: str | None
    version: int


class TaskListOut(BaseModel):
    items: list[TaskOut]
    total: int


# ---------------------------------------------------------------- planner
class PlannerBucket(BaseModel):
    key: str
    label: str
    tasks: list[TaskOut]


class PlannerOut(BaseModel):
    date_from: date
    date_to: date
    overdue: list[TaskOut]
    today: list[TaskOut]
    week: list[TaskOut]
    later: list[TaskOut]
    needs_review: list[TaskOut]


class PlannerSummary(BaseModel):
    today: int
    overdue: int
    week: int
    needs_review: int
    completed_today: int


# ---------------------------------------------------------------- экран «Сегодня»
class TodayCounters(BaseModel):
    """Счётчики для KPI главного экрана (требования, п.19)."""

    today: int
    overdue: int
    payments: int
    review: int
    done_today: int
    week: int


class TodayOut(BaseModel):
    """Один запрос на весь экран «Сегодня» (п.19-31).

    items — открытые задачи (просроченные и сегодня), уже отсортированные:
    просроченные -> критичные -> по времени (п.22).
    done  — закрытые сегодня, для кнопки «Показать выполненные» (п.31).
    """

    date: date
    counters: TodayCounters
    items: list[TaskOut]
    done: list[TaskOut]


# ---------------------------------------------------------------- finance
class InvoiceCreate(BaseModel):
    project_id: str | None = None
    number: str | None = None
    issue_date: date | None = None
    due_date: date | None = None
    amount: float = 0
    currency: str = "RUB"
    status: Literal["draft", "issued", "paid", "void"] = "issued"


class InvoiceOut(ORMModel):
    id: str
    client_id: str
    project_id: str | None
    number: str | None
    issue_date: date | None
    due_date: date | None
    amount: float
    currency: str
    status: str


class PaymentCreate(BaseModel):
    paid_at: date | None = None
    amount: float
    currency: str = "RUB"
    reference: str | None = None


class PaymentOut(ORMModel):
    id: str
    client_id: str
    paid_at: date | None
    amount: float
    currency: str
    reference: str | None


class AllocationIn(BaseModel):
    invoice_id: str
    amount: float


class FinancialSummary(BaseModel):
    billed: float
    paid: float
    allocated: float
    debt: float
    overdue_amount: float
    currency: str = "RUB"
    invoices: int
    unpaid_invoices: int


# ---------------------------------------------------------------- documents
class DocumentOut(ORMModel):
    id: str
    client_id: str
    project_id: str | None
    filename: str
    mime_type: str
    size: int
    created_at: datetime


# ---------------------------------------------------------------- reports
class ReportRequest(BaseModel):
    format: Literal["pdf", "xlsx"] = "pdf"
    scope: Literal["all", "client"] = "all"
    client_id: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    statuses: list[str] = Field(default_factory=list)
    # Состав отчёта (§7, п.88–89). Пустой список = всё, что есть.
    # projects — объекты и договоры, tasks — задачи и обязательства,
    # finance — invoices/payments и задолженность.
    sections: list[Literal["projects", "tasks", "finance"]] = Field(default_factory=list)


class ReportOut(ORMModel):
    id: str
    format: str
    scope: str
    client_id: str | None
    status: str
    error: str | None
    created_at: datetime
    finished_at: datetime | None


# ---------------------------------------------------------------- notifications
class NotificationOut(ORMModel):
    id: str
    task_id: str | None
    channel: str
    title: str
    body: str | None
    scheduled_at: datetime
    read_at: datetime | None
    status: str


class NotificationSettingsIn(BaseModel):
    channels: list[str] = Field(default_factory=lambda: ["in_app"])
    quiet_hours_start: str | None = "22:00"
    quiet_hours_end: str | None = "08:00"
    morning_digest: bool = True
    overdue_alerts: bool = True
    due_soon_alerts: bool = True


# ---------------------------------------------------------------- admin/sync
class TransferRequest(BaseModel):
    to_user_id: str
    comment: str | None = None


class AISettingsIn(BaseModel):
    model: str | None = None
    enabled: bool | None = None
    max_tokens: int | None = None


class SyncOperationIn(BaseModel):
    operation_id: str
    entity: str
    action: Literal["create", "update", "delete"]
    base_version: int | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class SyncPushRequest(BaseModel):
    operations: list[SyncOperationIn] = Field(default_factory=list)


class SyncPushResult(BaseModel):
    operation_id: str
    status: str
    entity_id: str | None = None
    conflict: bool = False
    message: str | None = None


class SyncPushResponse(BaseModel):
    results: list[SyncPushResult]
    server_time: datetime


class SyncPullResponse(BaseModel):
    since: int
    until: int
    changes: list[dict[str, Any]]
    server_time: datetime


class ImportResult(BaseModel):
    source: str
    clients_created: int
    clients_reused: int
    projects_created: int
    tasks_created: int
    problems_created: int
    skipped_rows: list[int]
    warnings: list[str] = Field(default_factory=list)


class DashboardOut(BaseModel):
    user: UserOut
    summary: PlannerSummary
    financial: FinancialSummary
    overdue: list[TaskOut]
    today: list[TaskOut]
    critical_clients: list[dict[str, Any]]
    ai_health: dict[str, Any]


TokenResponse.model_rebuild()
