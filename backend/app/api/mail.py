"""Per-user connected Zimbra mailbox and reviewed outgoing mail."""
from __future__ import annotations

import re
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, EmailStr, Field, SecretStr, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, get_client_or_404, get_current_user
from ..models import AuditLog, Client, ClientContact, Document, MailAccount, Project, User
from ..services.ai import _strip_json
from ..services.zimbra import MailError, Zimbra

router = APIRouter(prefix="/mail", tags=["mail"])


class Connection(BaseModel):
    url: str = Field(min_length=8, max_length=255)
    username: str = Field(min_length=1, max_length=255)
    password: SecretStr | None = None


class Message(BaseModel):
    to: EmailStr
    recipient_name: str | None = Field(default=None, max_length=255)
    subject: str = Field(min_length=1, max_length=255)
    body: str = Field(min_length=1, max_length=20000)
    document_ids: list[str] = Field(default_factory=list, max_length=10)
    request_id: UUID


class Instruction(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _failure(status: int, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message})


def _origin(url: str) -> str:
    try:
        parsed = urlsplit(url.strip())
        origin = f"https://{parsed.netloc.lower()}"
        if parsed.scheme != "https" or parsed.username or parsed.password or not parsed.hostname:
            raise ValueError
    except ValueError:
        raise _failure(422, "Введите адрес HTTPS сервера Zimbra.")
    if origin not in settings.zimbra_origins:
        raise _failure(422, "Сервер Zimbra не добавлен в FORTEON_ZIMBRA_ORIGINS на сервере ForteOn.")
    return origin


def _cipher() -> Fernet:
    try:
        return Fernet(settings.mail_secret.encode("ascii"))
    except ValueError:
        raise _failure(503, "На сервере ForteOn нужно настроить FORTEON_MAIL_SECRET.")


@contextmanager
def _connection(origin: str, username: str, password: str):
    _origin(origin)
    try:
        with httpx.Client(timeout=20, follow_redirects=False) as http:
            service = Zimbra(http, origin)
            service.sign_in(username, password)
            yield service
    except MailError as error:
        raise _failure(502, str(error)) from None
    except (httpx.HTTPError, OSError):
        raise _failure(502, "Не удалось выполнить запрос к Zimbra. Проверьте подключение.") from None


def _mailbox(db: Session, user: User):
    account = db.get(MailAccount, user.id)
    if not account:
        raise _failure(409, "Подключите почту в настройках ForteOn.")
    try:
        password = _cipher().decrypt(account.sealed_password).decode("utf-8")
    except InvalidToken:
        raise _failure(409, "Снова сохраните пароль для почтового ящика.")
    return _connection(account.origin, account.username, password)


@router.get("/connection")
def connection_info(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    account = db.get(MailAccount, user.id)
    default = settings.zimbra_origins[0] if len(settings.zimbra_origins) == 1 else ""
    return {"url": account.origin if account else default, "username": account.username if account else "", "connected": bool(account)}


@router.put("/connection")
def save_connection(payload: Connection, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    origin = _origin(payload.url)
    username = payload.username.strip()
    if not username:
        raise _failure(422, "Введите логин.")
    cipher = _cipher()
    account = db.get(MailAccount, user.id)
    password = payload.password.get_secret_value() if payload.password else ""
    if not password and account and (account.origin, account.username) == (origin, username):
        try:
            password = cipher.decrypt(account.sealed_password).decode()
        except InvalidToken:
            raise _failure(409, "Введите пароль заново.")
    if not password:
        raise _failure(422, "Введите пароль.")
    with _connection(origin, username, password):
        pass
    encrypted = cipher.encrypt(password.encode())
    if account:
        account.origin, account.username, account.sealed_password = origin, username, encrypted
    else:
        db.add(MailAccount(user_id=user.id, origin=origin, username=username, sealed_password=encrypted))
    db.commit()
    return {"url": origin, "username": username, "connected": True}


@router.delete("/connection", status_code=204)
def disconnect(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    account = db.get(MailAccount, user.id)
    if account:
        db.delete(account)
        db.commit()


def _crm_recipients(db: Session, user: User, query: str, projects_only: bool = False) -> list[dict[str, str]]:
    scope = [Client.deleted_at.is_(None)]
    if user.role != "admin":
        scope.append(Client.owner_id == user.id)
    needle = query.casefold().replace("ё", "е")
    results = []
    for model in ((Project,) if projects_only else (ClientContact, Project)):
        found = db.execute(select(model.name, model.email).join(Client).where(
            *scope, model.deleted_at.is_(None), model.email.is_not(None),
        ))
        results.extend(
            {"name": name, "email": address, "source": "project" if model is Project else "contact"}
            for name, address in found
            if needle in f"{name} {address}".casefold().replace("ё", "е")
        )
    return results[:20]


@router.get("/recipients")
def recipients(
    q: str = Query(default="", max_length=128), source: Literal["project"] | None = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    query = q.strip()
    if source == "project":
        return {"items": _crm_recipients(db, user, query, projects_only=True)}
    if len(query) < 2:
        return {"items": []}
    items = _crm_recipients(db, user, query)
    if db.get(MailAccount, user.id):
        with _mailbox(db, user) as mailbox:
            items.extend(mailbox.contacts(query))
    deduplicated = {}
    for entry in items:
        deduplicated.setdefault(entry["email"].casefold(), entry)
    return {"items": list(deduplicated.values())[:20]}


@router.get("/documents")
def documents(q: str = Query(min_length=2, max_length=128), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    needle = q.strip().casefold()
    if not needle:
        return {"items": []}
    query = select(Document).join(Client).where(Document.deleted_at.is_(None), Client.deleted_at.is_(None))
    if user.role != "admin":
        query = query.where(Client.owner_id == user.id)
    return {"items": [
        {"id": doc.id, "filename": doc.filename, "size": doc.size}
        for doc in db.scalars(query.order_by(Document.created_at.desc()))
        if needle in doc.filename.casefold()
    ][:20]}


def _ai_draft(text: str) -> dict | None:
    if not settings.ai_enabled or not settings.ai_api_key:
        return None
    try:
        with httpx.Client(timeout=min(settings.ai_timeout_seconds, 20)) as http:
            response = http.post(
                f"{settings.ai_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.ai_api_key}", "X-Title": "ForteOn Forti"},
                json={
                    "model": settings.ai_model,
                    "temperature": 0,
                    "max_tokens": 650,
                    "messages": [
                        {"role": "system", "content": (
                            "Составь короткий черновик делового письма из команды пользователя. "
                            "Верни только JSON: recipient_query, subject, body — строки. "
                            "recipient_query — точное имя, фамилия в именительном падеже или адрес из команды. "
                            "Если адресат не назван, верни пустую строку. Не выдумывай имена, адреса, "
                            "ссылки, вложения, суммы и сроки. Сохрани переданные ссылки без изменений. "
                            "Письмо только готовится к проверке. Не заявляй, что оно отправлено."
                        )},
                        {"role": "user", "content": text},
                    ],
                },
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            return _strip_json(content) if isinstance(content, str) else None
    except (httpx.HTTPError, ValueError, TypeError, KeyError, IndexError):
        return None


@router.post("/draft")
def draft(payload: Instruction, _: User = Depends(get_current_user)):
    text = payload.text.strip()
    recipient = re.search(r"[\w.+-]+@[\w.-]+\.[\w-]+", text)
    named = re.search(
        r"(?:кому\s*[:—-]\s*|(?:письмо|документы|файлы|письмо\s+для)\s+)([А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+){0,2})",
        text,
    )
    lookup = recipient.group() if recipient else named.group(1) if named else ""
    if lookup and not recipient:
        lookup = re.sub(r"(?<=[вн])у\b", "", lookup)
    links = re.findall(r"https://[^\s<>]+", text)
    content = re.search(r"(?:текст|напиши)\s*[:—]\s*(.+)", text, flags=re.IGNORECASE | re.DOTALL)
    subject = re.search(r"тема\s*[:—]\s*([^\n;.]+)", text, flags=re.IGNORECASE)
    files = bool(re.search(r"документ|файл|вложени", text, flags=re.IGNORECASE))
    default_body = "Здравствуйте!\n\nНаправляю документы." if files else "Здравствуйте!\n\n"
    body = content.group(1).strip() if content else default_body
    if links and not content:
        body += "\n\n" + "\n".join(links)
    result = {"recipient_query": lookup, "subject": subject.group(1).strip() if subject else ("Документы" if files else ""), "body": body}
    ai = _ai_draft(text)
    if ai:
        for field, limit in (("subject", 255), ("body", 20000)):
            if isinstance(ai.get(field), str) and ai[field].strip():
                result[field] = ai[field].strip()[:limit]
        lookup_from_ai = ai.get("recipient_query")
        if not lookup and isinstance(lookup_from_ai, str):
            # A model may extract a name, but only directory results can supply a new address.
            result["recipient_query"] = lookup_from_ai.replace("@", " ").strip()[:128]
    for link in links:
        if link not in result["body"]:
            result["body"] += "\n" + link
    return {**result, "used_ai": bool(ai)}


def _attachment(db: Session, user: User, doc_id: str) -> tuple[str, Path, str]:
    document = db.get(Document, doc_id)
    if not document or document.deleted_at:
        raise _failure(404, "Документ не найден.")
    get_client_or_404(db, user, document.client_id)
    root = settings.storage_dir.resolve()
    path = (root / document.storage_key).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise _failure(404, "Файл вложения недоступен.")
    return document.filename, path, document.mime_type


def _deliver(payload: Message, db: Session, user: User, files: list[tuple[str, Path, str]]):
    if not payload.subject.strip() or not payload.body.strip():
        raise _failure(422, "Заполните тему и текст письма.")
    already_sent = db.scalar(select(AuditLog.id).where(
        AuditLog.actor_id == user.id, AuditLog.entity == "mail", AuditLog.entity_id == str(payload.request_id),
        AuditLog.action == "sent",
    ).limit(1))
    if already_sent:
        return {"sent": True}
    files = [*files, *(_attachment(db, user, doc_id) for doc_id in dict.fromkeys(payload.document_ids))]
    if len(files) > 10 or sum(path.stat().st_size for _, path, _ in files) > settings.max_upload_bytes:
        raise _failure(422, "Общий размер вложений превышает лимит сервера.")
    with _mailbox(db, user) as mailbox:
        mailbox.send(payload.to, payload.subject.strip(), payload.body, str(payload.request_id), files, payload.recipient_name)
    audit(db, user, "mail", str(payload.request_id), "sent", {"attachments": len(files)})
    db.commit()
    return {"sent": True}


@router.post("/send")
def send_message(payload: Message, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _deliver(payload, db, user, [])


@router.post("/send-files")
def send_with_files(
    message: str = Form(...), attachments: list[UploadFile] = File(...),
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    try:
        payload = Message.model_validate_json(message)
    except ValidationError:
        raise _failure(422, "Проверьте адрес, тему и текст письма.") from None
    if len(attachments) + len(set(payload.document_ids)) > 10:
        raise _failure(422, "Можно приложить до 10 файлов.")
    remaining = settings.max_upload_bytes
    files = []
    with TemporaryDirectory(prefix="forteon-mail-") as temporary:
        for index, attachment in enumerate(attachments):
            path = Path(temporary) / str(index)
            with path.open("wb") as output:
                while chunk := attachment.file.read(65536):
                    remaining -= len(chunk)
                    if remaining < 0:
                        raise _failure(422, "Общий размер вложений превышает лимит сервера.")
                    output.write(chunk)
            name = Path((attachment.filename or "document").replace(chr(92), "/")).name
            files.append((name, path, attachment.content_type or "application/octet-stream"))
        return _deliver(payload, db, user, files)
