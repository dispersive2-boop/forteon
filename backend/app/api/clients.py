"""Клиенты, контакты, проекты, договоры, документы."""
from __future__ import annotations

import hashlib
import json
import mimetypes
import shutil
import uuid
from datetime import date

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, bump_version, ensure_version, get_client_or_404, get_current_user
from ..models import (
    AuditLog,
    Client,
    ClientContact,
    Contract,
    Document,
    Invoice,
    Payment,
    PaymentAllocation,
    Project,
    ProjectModule,
    Task,
    User,
    utcnow,
)
from ..schemas import (
    ClientCreate,
    ClientDetailOut,
    ClientOut,
    ClientUpdate,
    ContactIn,
    ContactOut,
    ContractCreate,
    ContractOut,
    DocumentOut,
    PagedClients,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
)

router = APIRouter(tags=["clients"])


def fold(value: str | None) -> str:
    """Нормализация для поиска: регистр + «ё» и «е» считаются одной буквой.

    casefold() — потому что SQLite LOWER() не понимает кириллицу.
    ё→е — потому что «Новосибёрск» и «Новосибирск» для человека одно слово,
    а для сравнения строк — разные.
    """
    return (value or "").casefold().replace("ё", "е")


@router.get("/clients", response_model=PagedClients)
def list_clients(
    q: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = select(Client).where(Client.deleted_at.is_(None))
    if user.role != "admin":
        query = query.where(Client.owner_id == user.id)
    if status_filter:
        query = query.where(Client.status == status_filter)

    needle = (q or "").strip()
    if not needle:
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        if cursor:
            query = query.where(Client.name > cursor)
        rows = list(db.scalars(query.order_by(Client.name).limit(limit)))
        next_cursor = rows[-1].name if len(rows) == limit else None
        return PagedClients(
            items=[ClientOut.model_validate(c) for c in rows],
            next_cursor=next_cursor,
            total=total,
        )

    # Поиск с запросом считаем в Python, а не через SQL LIKE.
    #
    # Причина: SQLite применяет LOWER() только к ASCII. Для кириллицы
    # lower('Байкальск') возвращает 'Байкальск' без изменений, поэтому
    # запрос «байкальск» не находил клиента «Байкальская Нерпа» — поиск по
    # русским названиям молча не работал. casefold() корректен для Unicode.
    # Объём — сотни клиентов на менеджера, фильтрация в памяти дешевле.
    needle_cf = fold(needle)

    matched_contact_ids = {
        client_id
        for client_id, name, phone, email in db.execute(
            select(
                ClientContact.client_id,
                ClientContact.name,
                ClientContact.phone,
                ClientContact.email,
            )
        ).all()
        if needle_cf in fold(name)
        or needle_cf in fold(phone)
        or needle_cf in fold(email)
    }

    candidates = [
        c
        for c in db.scalars(query.order_by(Client.name))
        if needle_cf in fold(c.name)
        or needle_cf in fold(c.legal_name)
        or needle_cf in fold(c.tax_id)
        or needle_cf in fold(c.registration_id)
        or needle_cf in fold(c.address)
        or c.id in matched_contact_ids
    ]

    # Курсор тоже применяем в памяти: отбор уже не описывается одним WHERE.
    if cursor:
        candidates = [c for c in candidates if c.name > cursor]

    total = len(candidates)
    rows = candidates[:limit]
    next_cursor = rows[-1].name if len(rows) == limit else None
    return PagedClients(
        items=[ClientOut.model_validate(c) for c in rows],
        next_cursor=next_cursor,
        total=total,
    )


@router.get("/clients/picker")
def clients_picker(
    q: str | None = None,
    limit: int = Query(default=12, ge=1, le=50),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Подбор клиента для быстрого ввода заметки.

    Релевантность считается на сервере:
      1. совпадение в начале названия   +100
      2. совпадение внутри названия      +60
      3. открытые задачи                 до +30
      4. свежесть последней заметки      до +50 (сутки = максимум)
    Без запроса сверху идут те, с кем общались недавно, ниже — «забытые».
    """
    from datetime import datetime, timedelta
    from ..models import Note

    query = select(Client).where(Client.deleted_at.is_(None))
    if user.role != "admin":
        query = query.where(Client.owner_id == user.id)

    needle = (q or "").strip()
    needle_cf = fold(needle)

    # Кандидатов всегда берём из общей выборки (owner-скоуп уже применён),
    # а совпадения считаем в Python через fold() — см. комментарий к fold().
    # Объём — сотни клиентов, фильтрация в памяти дешевле ошибки поиска.
    candidates = list(db.scalars(query.limit(400)))

    if needle:
        # Контакт ищем по трём полям: имя, телефон, email (п.48).
        matched_contact_ids = {
            client_id
            for client_id, name, phone, email in db.execute(
                select(
                    ClientContact.client_id,
                    ClientContact.name,
                    ClientContact.phone,
                    ClientContact.email,
                )
            ).all()
            if needle_cf in fold(name)
            or needle_cf in fold(phone)
            or needle_cf in fold(email)
        }
        candidates = [
            c for c in candidates
            if needle_cf in fold(c.name)
            or needle_cf in fold(c.legal_name)
            or needle_cf in fold(c.tax_id)
            or needle_cf in fold(c.registration_id)
            or needle_cf in fold(c.address)
            or c.id in matched_contact_ids
        ]

    if not candidates:
        return {"items": [], "total": 0}

    ids = [c.id for c in candidates]

    last_notes: dict[str, datetime] = {}
    for client_id, last_at in db.execute(
        select(Note.client_id, func.max(Note.created_at))
        .where(Note.client_id.in_(ids), Note.deleted_at.is_(None))
        .group_by(Note.client_id)
    ).all():
        if last_at is not None:
            last_notes[client_id] = last_at

    open_tasks: dict[str, int] = {
        client_id: count
        for client_id, count in db.execute(
            select(Task.client_id, func.count())
            .where(Task.client_id.in_(ids), Task.status == "open", Task.deleted_at.is_(None))
            .group_by(Task.client_id)
        ).all()
    }

    now = utcnow()
    scored = []
    for client in candidates:
        score = 0
        name = (client.name or "").lower()
        legal = (client.legal_name or "").lower()

        if needle:
            if name.startswith(needle) or legal.startswith(needle):
                score += 100
            elif needle in name or needle in legal:
                score += 60

        score += min(open_tasks.get(client.id, 0), 10) * 3

        last_at = last_notes.get(client.id)
        if last_at is not None:
            age_days = max((now - last_at).total_seconds() / 86400.0, 0.0)
            score += max(0.0, 50.0 - age_days * 2.0)

        scored.append((score, last_at, client))

    # datetime.min.timestamp() падает на Windows (выход за диапазон).
    # Безопасно: клиенты без заметок получают 0.0 и уходят в конец.
    scored.sort(
        key=lambda item: (
            -item[0],
            -(item[1].timestamp() if item[1] else 0.0),
            item[2].name,
        )
    )
    top = scored[:limit]

    items = []
    for score, last_at, client in top:
        payload = ClientOut.model_validate(client).model_dump()
        payload["last_note_at"] = last_at.isoformat() if last_at else None
        payload["open_tasks"] = open_tasks.get(client.id, 0)
        payload["score"] = round(score, 1)
        items.append(payload)

    return {"items": items, "total": len(items)}


@router.post("/clients", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
def create_client(payload: ClientCreate, request: Request, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    exists = db.scalar(
        select(Client).where(Client.owner_id == user.id, func.lower(Client.name) == payload.name.strip().lower(),
                             Client.deleted_at.is_(None))
    )
    if exists:
        raise HTTPException(status_code=409, detail={"code": "duplicate", "message": "Клиент с таким названием уже есть"})
    client = Client(
        owner_id=user.id,
        type=payload.type,
        name=payload.name.strip(),
        legal_name=payload.legal_name,
        tax_id=payload.tax_id,
        registration_id=payload.registration_id,
        address=payload.address,
        status=payload.status,
        notes_public=payload.notes_public,
    )
    db.add(client)
    db.flush()
    for contact in payload.contacts:
        db.add(ClientContact(client_id=client.id, **contact.model_dump()))
    audit(db, user, "client", client.id, "created", {"name": client.name},
          request.client.host if request.client else None)
    db.commit()
    db.refresh(client)
    return ClientOut.model_validate(client)


@router.get("/clients/{client_id}", response_model=ClientDetailOut)
def get_client(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    contacts = list(db.scalars(select(ClientContact).where(ClientContact.client_id == client.id)))
    projects_count = db.scalar(
        select(func.count()).select_from(Project).where(Project.client_id == client.id, Project.deleted_at.is_(None))
    ) or 0
    open_tasks = db.scalar(
        select(func.count()).select_from(Task).where(
            Task.client_id == client.id, Task.status == "open", Task.deleted_at.is_(None)
        )
    ) or 0
    overdue = db.scalar(
        select(func.count()).select_from(Task).where(
            Task.client_id == client.id, Task.status == "open",
            Task.due_date.is_not(None), Task.due_date < date.today(), Task.deleted_at.is_(None),
        )
    ) or 0
    billed = db.scalar(
        select(func.coalesce(func.sum(Invoice.amount), 0)).where(
            Invoice.client_id == client.id, Invoice.status != "void"
        )
    ) or 0
    invoice_ids = list(db.scalars(select(Invoice.id).where(Invoice.client_id == client.id)))
    allocated = 0.0
    if invoice_ids:
        allocated = db.scalar(
            select(func.coalesce(func.sum(PaymentAllocation.amount), 0)).where(
                PaymentAllocation.invoice_id.in_(invoice_ids)
            )
        ) or 0

    detail = ClientDetailOut.model_validate(client)
    detail.contacts = [ContactOut.model_validate(c) for c in contacts]
    detail.projects_count = projects_count
    detail.open_tasks = open_tasks
    detail.overdue_tasks = overdue
    detail.debt = round(float(billed) - float(allocated), 2)
    return detail


@router.patch("/clients/{client_id}", response_model=ClientOut)
def update_client(client_id: str, payload: ClientUpdate, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    ensure_version(client, payload.version)
    data = payload.model_dump(exclude_unset=True, exclude={"version"})
    for key, value in data.items():
        if value is not None:
            setattr(client, key, value)
    bump_version(client)
    audit(db, user, "client", client.id, "updated", {"fields": list(data)},
          request.client.host if request.client else None)
    db.commit()
    db.refresh(client)
    return ClientOut.model_validate(client)


@router.delete("/clients/{client_id}")
def delete_client(client_id: str, request: Request, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    client.deleted_at = utcnow()
    bump_version(client)
    audit(db, user, "client", client.id, "deleted", ip=request.client.host if request.client else None)
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------- contacts
@router.get("/clients/{client_id}/contacts", response_model=list[ContactOut])
def list_contacts(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    rows = db.scalars(select(ClientContact).where(ClientContact.client_id == client.id))
    return [ContactOut.model_validate(c) for c in rows]


@router.post("/clients/{client_id}/contacts", response_model=ContactOut, status_code=201)
def add_contact(client_id: str, payload: ContactIn, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    contact = ClientContact(client_id=client.id, **payload.model_dump())
    db.add(contact)
    db.commit()
    db.refresh(contact)
    return ContactOut.model_validate(contact)


@router.patch("/contacts/{contact_id}", response_model=ContactOut)
def update_contact(contact_id: str, payload: ContactIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    contact = db.get(ClientContact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Контакт не найден"})
    get_client_or_404(db, user, contact.client_id)
    for key, value in payload.model_dump().items():
        setattr(contact, key, value)
    contact.version = (contact.version or 1) + 1
    db.commit()
    db.refresh(contact)
    return ContactOut.model_validate(contact)


@router.delete("/contacts/{contact_id}")
def delete_contact(contact_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    contact = db.get(ClientContact, contact_id)
    if contact is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Контакт не найден"})
    get_client_or_404(db, user, contact.client_id)
    db.delete(contact)
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------- projects
@router.get("/clients/{client_id}/projects", response_model=list[ProjectOut])
def list_projects(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    rows = db.scalars(
        select(Project).where(Project.client_id == client.id, Project.deleted_at.is_(None)).order_by(Project.name)
    )
    return [ProjectOut.model_validate(p) for p in rows]


@router.post("/clients/{client_id}/projects", response_model=ProjectOut, status_code=201)
def create_project(client_id: str, payload: ProjectCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    project = Project(client_id=client.id, **payload.model_dump())
    db.add(project)
    db.commit()
    db.refresh(project)
    return ProjectOut.model_validate(project)


@router.patch("/projects/{project_id}", response_model=ProjectOut)
def update_project(project_id: str, payload: ProjectUpdate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    project = db.get(Project, project_id)
    if project is None or project.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Проект не найден"})
    get_client_or_404(db, user, project.client_id)
    ensure_version(project, payload.version)
    for key, value in payload.model_dump(exclude_unset=True, exclude={"version"}).items():
        if value is not None:
            setattr(project, key, value)
    project.version = (project.version or 1) + 1
    db.commit()
    db.refresh(project)
    return ProjectOut.model_validate(project)


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Проект не найден"})
    get_client_or_404(db, user, project.client_id)
    project.deleted_at = utcnow()
    project.version = (project.version or 1) + 1
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------- modules
@router.get("/projects/{project_id}/modules")
def list_modules(project_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Проект не найден"})
    get_client_or_404(db, user, project.client_id)
    rows = db.scalars(select(ProjectModule).where(ProjectModule.project_id == project_id))
    return [
        {"id": m.id, "name": m.name, "status": m.status, "description": m.description} for m in rows
    ]


@router.post("/projects/{project_id}/modules", status_code=201)
def create_module(project_id: str, body: dict, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Проект не найден"})
    get_client_or_404(db, user, project.client_id)
    module = ProjectModule(
        project_id=project_id,
        name=str(body.get("name") or "Модуль"),
        status=str(body.get("status") or "planned"),
        description=body.get("description"),
    )
    db.add(module)
    db.commit()
    db.refresh(module)
    return {"id": module.id, "name": module.name, "status": module.status, "description": module.description}


# ---------------------------------------------------------------- contracts
@router.get("/clients/{client_id}/contracts", response_model=list[ContractOut])
def list_contracts(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    rows = db.scalars(
        select(Contract).where(Contract.client_id == client.id, Contract.deleted_at.is_(None))
    )
    return [ContractOut.model_validate(c) for c in rows]


@router.post("/clients/{client_id}/contracts", response_model=ContractOut, status_code=201)
def create_contract(client_id: str, payload: ContractCreate, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    contract = Contract(client_id=client.id, **payload.model_dump())
    db.add(contract)
    db.commit()
    db.refresh(contract)
    return ContractOut.model_validate(contract)


@router.delete("/contracts/{contract_id}")
def delete_contract(contract_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    contract = db.get(Contract, contract_id)
    if contract is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Договор не найден"})
    get_client_or_404(db, user, contract.client_id)
    contract.deleted_at = utcnow()
    db.commit()
    return {"status": "ok"}


# ---------------------------------------------------------------- история
@router.get("/clients/{client_id}/history")
def client_history(client_id: str, limit: int = Query(default=100, ge=1, le=300),
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """История существенных действий по клиенту — из `audit_log`.

    Раньше вкладка «История» собиралась в браузере из заметок и выполненных
    задач: смены статуса, правки финансов и передачи клиента туда не попадали.
    Здесь отдаём фактические события аудита, относящиеся к клиенту или к его
    счетам, оплатам, задачам, проектам и документам.
    """
    client = get_client_or_404(db, user, client_id)

    invoice_ids = [str(x) for x in db.scalars(
        select(Invoice.id).where(Invoice.client_id == client.id)
    )]
    payment_ids = [str(x) for x in db.scalars(
        select(Payment.id).where(Payment.client_id == client.id)
    )]
    task_ids = [str(x) for x in db.scalars(
        select(Task.id).where(Task.client_id == client.id)
    )]
    project_ids = [str(x) for x in db.scalars(
        select(Project.id).where(Project.client_id == client.id)
    )]

    allocation_ids: list[str] = []
    if invoice_ids:
        allocation_ids = [str(x) for x in db.scalars(
            select(PaymentAllocation.id).where(PaymentAllocation.invoice_id.in_(invoice_ids))
        )]

    clause = AuditLog.entity_id == client.id
    if invoice_ids:
        clause = or_(clause, (AuditLog.entity == "invoice") & AuditLog.entity_id.in_(invoice_ids))
    if payment_ids:
        clause = or_(clause, (AuditLog.entity == "payment") & AuditLog.entity_id.in_(payment_ids))
    if allocation_ids:
        # Распределение оплаты — тоже денежное событие клиента: без него
        # откат оплаты не виден в истории.
        clause = or_(clause, (AuditLog.entity == "allocation") & AuditLog.entity_id.in_(allocation_ids))
    if task_ids:
        clause = or_(clause, (AuditLog.entity == "task") & AuditLog.entity_id.in_(task_ids))
    if project_ids:
        clause = or_(clause, (AuditLog.entity == "project") & AuditLog.entity_id.in_(project_ids))

    rows = list(db.scalars(
        select(AuditLog).where(clause).order_by(AuditLog.created_at.desc()).limit(limit)
    ))

    actors: dict[str, str] = {}
    actor_ids = {row.actor_id for row in rows if row.actor_id}
    if actor_ids:
        for person in db.scalars(select(User).where(User.id.in_(actor_ids))):
            actors[person.id] = person.full_name or person.email

    return {
        "items": [
            {
                "id": row.id,
                "entity": row.entity,
                "entity_id": row.entity_id,
                "action": row.action,
                "metadata": json.loads(row.metadata_json) if row.metadata_json else None,
                "actor": actors.get(row.actor_id) if row.actor_id else None,
                "created_at": row.created_at,
            }
            for row in rows
        ],
        "total": len(rows),
    }


# ---------------------------------------------------------------- documents
@router.get("/clients/{client_id}/documents", response_model=list[DocumentOut])
def list_documents(client_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    client = get_client_or_404(db, user, client_id)
    rows = db.scalars(
        select(Document).where(Document.client_id == client.id, Document.deleted_at.is_(None))
        .order_by(Document.created_at.desc())
    )
    return [DocumentOut.model_validate(d) for d in rows]


@router.post("/documents/uploads", status_code=201)
async def upload_document(
    client_id: str,
    file: UploadFile = File(...),
    project_id: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    client = get_client_or_404(db, user, client_id)
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    if mime not in settings.allowed_mime:
        raise HTTPException(status_code=415, detail={"code": "bad_mime", "message": f"Формат не разрешён: {mime}"})

    target_dir = settings.storage_dir / client.id
    target_dir.mkdir(parents=True, exist_ok=True)
    storage_key = f"{client.id}/{uuid.uuid4().hex}_{file.filename}"
    target_path = settings.storage_dir / storage_key

    digest = hashlib.sha256()
    size = 0
    with target_path.open("wb") as output:
        while chunk := await file.read(1024 * 512):
            size += len(chunk)
            if size > settings.max_upload_bytes:
                output.close()
                target_path.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail={"code": "too_large", "message": "Файл слишком большой"})
            digest.update(chunk)
            output.write(chunk)

    document = Document(
        client_id=client.id,
        project_id=project_id,
        storage_key=storage_key,
        filename=file.filename or "document",
        mime_type=mime,
        size=size,
        checksum=digest.hexdigest(),
        uploaded_by=user.id,
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return DocumentOut.model_validate(document)


def _document_for_user(db: Session, user: User, document_id: str) -> Document:
    document = db.get(Document, document_id)
    if document is None or document.deleted_at is not None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Документ не найден"})
    get_client_or_404(db, user, document.client_id)
    return document


@router.get("/documents/{document_id}", response_model=DocumentOut)
def get_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return DocumentOut.model_validate(_document_for_user(db, user, document_id))


@router.get("/documents/{document_id}/download")
def download_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    document = _document_for_user(db, user, document_id)
    path = settings.storage_dir / document.storage_key
    if not path.exists():
        raise HTTPException(status_code=410, detail={"code": "gone", "message": "Файл отсутствует в хранилище"})
    return FileResponse(path, filename=document.filename, media_type=document.mime_type)


@router.delete("/documents/{document_id}")
def delete_document(document_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    document = _document_for_user(db, user, document_id)
    document.deleted_at = utcnow()
    db.commit()
    return {"status": "ok"}
