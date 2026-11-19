"""Журнал изменений для синхронизации (ChangeLog).

Зачем: `/sync/pull` отдаёт данные из `change_log`, но до этого модуля туда
никто не писал — курсор всегда оставался нулевым, и офлайн-клиент не получал
изменений вообще. Здесь одна функция, чтобы финансовые операции (A-P0-2)
попадали в журнал так же, как и остальные сущности.

Модуль намеренно без побочных эффектов: только `db.add`, коммит делает
вызывающий код в своей транзакции.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from ..models import ChangeLog

# Действия, которые понимает клиент синхронизации.
ACTION_UPSERT = "upsert"
ACTION_DELETE = "delete"
ACTION_TOMBSTONE = "tombstone"


def record_change(
    db: Session,
    *,
    entity: str,
    entity_id: str | None,
    action: str,
    owner_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Добавляет запись в журнал изменений.

    `owner_id` — владелец клиента: `/sync/pull` фильтрует по нему, чтобы
    менеджер не получал чужие данные. Для сущностей без владельца
    (например, справочников) оставляем None — такие видят все.
    """
    if not entity_id:
        return
    db.add(
        ChangeLog(
            entity=entity,
            entity_id=str(entity_id),
            action=action,
            owner_id=owner_id,
            payload=json.dumps(payload, ensure_ascii=False, default=str) if payload else None,
        )
    )
