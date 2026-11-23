# -*- coding: utf-8 -*-
"""Предлагаемый текст следующего сообщения клиенту (п.25 «30 идей»).

Почему без AI
-------------
Соблазнительно отдать это модели, но у подсказки есть жёсткое требование:
источник. Менеджер должен видеть, ИЗ ЧЕГО взялся текст — из заметки, из
цитаты задачи или из обязательства. Модель же даёт гладкий текст и ничего
не даёт в источнике: «здравствуйте, хочу уточнить» ни к чему не привязано.

Поэтому здесь детерминированные шаблоны по типу задачи. Они всегда
воспроизводимы, дешёвы и не врут: текст строится ровно из того, что
записано в базе. Отправку всё равно делает менеджер — мы только подставляем
черновик, который он правит.

Правило одно: если источника нет, честно говорим об этом, а не сочиняем
повод. Пустой повод хуже отсутствия подсказки.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Client, Commitment, Note, Task

# Заготовки по типу действия. Тон деловой, без «Уважаемый клиент».
# {what} — суть дела словами из задачи/заметки.
_TEMPLATES = {
    "call": "Здравствуйте! По «{what}» — удобно созвониться сегодня или завтра?",
    "payment": "Здравствуйте! Напоминаю про оплату по «{what}». Если нужны документы — пришлю.",
    "document": "Здравствуйте! По «{what}» — подготовил документы, могу отправить на подпись.",
    "meeting": "Здравствуйте! По «{what}» — предлагаю встречу на этой неделе. Когда удобно?",
    "email": "Здравствуйте! По «{what}» — коротко о статусе, отвечу на вопросы.",
    "task": "Здравствуйте! По «{what}» — уточню детали и вернусь с решением.",
}

_DEFAULT_TEMPLATE = "Здравствуйте! По «{what}» — уточню детали и вернусь с ответом."


@dataclass(frozen=True)
class Suggestion:
    """Черновик сообщения вместе с тем, откуда он взялся."""

    text: str
    # note | task | commitment | none
    source_kind: str
    source_id: str | None
    # Цитата или фраза основания — менеджер видит, почему такой текст.
    source_quote: str | None
    # Человеческая подпись источника: «заметка от 12.11», «цитата задачи».
    source_label: str


def _clip(value: str | None, limit: int = 160) -> str | None:
    if not value:
        return None
    clean = " ".join(value.split())
    if not clean:
        return None
    return clean if len(clean) <= limit else clean[: limit - 1].rstrip() + "…"


def _short_date(moment) -> str:
    return moment.strftime("%d.%m") if moment else ""


def suggest_message(db: Session, task: Task) -> Suggestion:
    """Строит черновик следующего сообщения по задаче.

    Порядок источников:
      1. цитата задачи (`source_quote`) — это то, что человек реально сказал;
      2. открытое обязательство клиента по клиенту — часто именно оно повод;
      3. последняя заметка по клиенту;
      4. ничего — тогда честно «нет основания».
    """
    template = _TEMPLATES.get(task.type or "", _DEFAULT_TEMPLATE)

    quote = _clip(task.source_quote)
    if quote:
        return Suggestion(
            text=template.format(what=_clip(task.title) or quote),
            source_kind="task",
            source_id=task.id,
            source_quote=quote,
            source_label="цитата из заметки, по которой создана задача",
        )

    commitment = db.scalar(
        select(Commitment)
        .where(
            Commitment.client_id == task.client_id,
            Commitment.status == "open",
        )
        .order_by(Commitment.created_at.desc())
        .limit(1)
    )
    if commitment is not None and commitment.description:
        what = _clip(commitment.description, 140)
        return Suggestion(
            text=template.format(what=what),
            source_kind="commitment",
            source_id=commitment.id,
            source_quote=what,
            source_label="открытое обязательство по клиенту",
        )

    note = db.scalar(
        select(Note)
        .where(Note.client_id == task.client_id, Note.deleted_at.is_(None))
        .order_by(Note.created_at.desc())
        .limit(1)
    )
    if note is not None:
        body = _clip(note.body, 200)
        return Suggestion(
            text=template.format(what=_clip(task.title) or body or "вашему вопросу"),
            source_kind="note",
            source_id=note.id,
            source_quote=body,
            source_label=f"последняя заметка от {_short_date(note.created_at)}",
        )

    # Ничего нет — не сочиняем. Менеджер сам решит, что писать.
    return Suggestion(
        text="",
        source_kind="none",
        source_id=None,
        source_quote=None,
        source_label="нет основания: ни заметок, ни обязательств по клиенту",
    )


def client_name(db: Session, task: Task) -> str | None:
    """Имя клиента для подстановки в подпись — отдельно, чтобы не тянуть
    связь в каждом вызове."""
    client = db.get(Client, task.client_id)
    return client.name if client else None
