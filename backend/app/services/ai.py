"""AI Extractor: одна заметка → структурированные задачи/обязательства (раздел 07).

Режимы:
* OpenRouter (если задан OPENROUTER_API_KEY) — короткий запрос к выбранной модели;
* локальный эвристический экстрактор — детерминированный fallback, работает без сети,
  используется для тестов и пилота без ключа.

Сервер всегда валидирует результат: типы, даты, права, дубли, бизнес-правила.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import httpx

from ..config import settings
from .dates import extract_due, is_conditional, is_negative, localize, utc_naive

log = logging.getLogger("forteon.ai")

PROMPT_VERSION = "v1"

SYSTEM_PROMPT = """Ты — экстрактор задач для CRM сопровождения клиентов.
Верни СТРОГО JSON без markdown:
{"tasks":[{"title":"","action_type":"call|email|meeting|document|payment|other",
"due_date":"YYYY-MM-DD|null","due_time":"HH:MM|null","timezone":"IANA",
"priority":"low|normal|high|critical","conditional":false,"source_quote":"","confidence":0.0}],
"commitments":[{"promised_by":"client|us","description":"","due_date":"YYYY-MM-DD|null","source_quote":""}],
"needs_review":[{"reason":"","source_quote":""}]}
Правила: не выдумывай даты; если срок неясен — due_date=null и добавь needs_review.
Отрицания («не звонить») и условные действия («если оплатят») отмечай conditional=true.
Максимум 6 задач. Только то, что явно следует из текста заметки."""

ACTION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "call": ("позвонить", "созвониться", "набрать", "звонок", "перезвонить", "обзвонить"),
    "email": ("письмо", "написать", "отправить", "почт", "e-mail", "email"),
    "meeting": ("встреч", "совещани", "переговор", "демо", "созвон", "встретиться"),
    "document": ("договор", "счёт", "счет", "акт", "кп", "документ", "подписать", "согласова", "заявк"),
    "payment": ("оплат", "платеж", "платёж", "счет", "счёт", "задолженност", "долг", "инвойс"),
    "other": (),
}

COMMITMENT_MARKERS = (
    "обещал", "обещали", "обещает", "пообещал", "обязуется", "должен оплатить",
    "ждём оплату", "ждем оплату", "будет оплачено", "переведёт", "переведет",
)
REVIEW_MARKERS = ("уточнить", "непонятно", "не ясно", "неясно", "надо уточнить", "не помню")


@dataclass
class ExtracteedTask:
    title: str
    action_type: str = "other"
    due_at: datetime | None = None
    priority: str = "normal"
    conditional: bool = False
    source_quote: str = ""
    confidence: float | None = None


@dataclass
class ExtracteedCommitment:
    promised_by: str = "client"
    description: str = ""
    due_at: datetime | None = None
    source_quote: str = ""


@dataclass
class ExtractionResult:
    tasks: list[ExtracteedTask] = field(default_factory=list)
    commitments: list[ExtracteedCommitment] = field(default_factory=list)
    needs_review: list[dict[str, Any]] = field(default_factory=list)
    model: str = "local-rules"
    prompt_version: str = PROMPT_VERSION
    tokens: int | None = None
    cost: float | None = None
    error: str | None = None
    offline: bool = True


def detect_action_type(text: str) -> str:
    low = text.lower()
    for action, words in ACTION_KEYWORDS.items():
        if any(w in low for w in words):
            return action
    return "other"


def detect_priority(text: str) -> str:
    low = text.lower()
    if any(w in low for w in ("срочно", "критично", "asap", "немедленно", "горит")):
        return "critical"
    if any(w in low for w in ("важно", "приоритет", "обязательно")):
        return "high"
    if any(w in low for w in ("потом", "не срочно", "второстепенно")):
        return "low"
    return "normal"


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?;])\s+|\n+|\s+—\s+", text)
    return [p.strip(" .;:-\t") for p in parts if p and len(p.strip()) > 3]


def _title_from(sentence: str) -> str:
    cleaned = re.sub(r"^\s*(?:-\s*)?", "", sentence).strip()
    cleaned = re.sub(r"^(?:надо|нужно|необходимо|следует)\s+", "", cleaned, flags=re.IGNORECASE)
    if len(cleaned) > 200:
        cleaned = cleaned[:197].rstrip() + "…"
    return cleaned[:1].upper() + cleaned[1:] if cleaned else "Задача"


def local_extract(body: str, note_moment: datetime, tz_name: str) -> ExtractionResult:
    """Детерминированный экстрактор без внешних вызовов."""
    result = ExtractionResult(model="local-rules")
    sentences = _sentences(body)
    now_local = localize(note_moment, tz_name)

    for sentence in sentences:
        low = sentence.lower()

        if any(marker in low for marker in NEGATORS_LOCAL) and not re.search(r"(?:не\s+)?(?:надо|нужно)", low):
            result.needs_review.append({
                "reason": "Отрицание в тексте — действие не создаём",
                "source_quote": sentence,
            })
            continue

        if is_negative(sentence):
            result.needs_review.append({"reason": "Отрицание: задача не создаётся", "source_quote": sentence})
            continue

        due_at, reason = extract_due(sentence, now_local, tz_name)
        has_action = any(w in low for w in ("нужно", "надо", "необходимо", "подготов", "позвон",
                                            "отправ", "напис", "подпис", "согласова", "оплат",
                                            "встрет", "сдела", "провер", "выясн", "уточн",
                                            "запрос", "напомн", "сформир", "переда"))
        commitment_hit = any(marker in low for marker in COMMITMENT_MARKERS)

        if commitment_hit:
            result.commitments.append(
                ExtracteedCommitment(
                    promised_by="client",
                    description=_title_from(sentence),
                    due_at=due_at,
                    source_quote=sentence,
                )
            )
            result.tasks.append(
                ExtracteedTask(
                    title=f"Проконтролировать: {_title_from(sentence)}",
                    action_type="payment" if extract_payment_word(low) else "other",
                    due_at=due_at,
                    priority="high",
                    conditional=is_conditional(sentence),
                    source_quote=sentence,
                    confidence=0.6,
                )
            )
            continue

        if not has_action and due_at is None:
            if any(marker in low for marker in REVIEW_MARKERS):
                result.needs_review.append({"reason": "Неоднозначная формулировка", "source_quote": sentence})
            continue

        if not has_action and due_at is not None:
            # «в пятницу совещание» — не действие, но может быть событием: отправляем на уточнение
            result.needs_review.append({"reason": "Дата без явного действия", "source_quote": sentence})
            continue

        result.tasks.append(
            ExtracteedTask(
                title=_title_from(sentence),
                action_type=detect_action_type(sentence),
                due_at=due_at,
                priority=detect_priority(sentence),
                conditional=is_conditional(sentence),
                source_quote=sentence,
                confidence=0.75 if reason != "none" else 0.5,
            )
        )

    if not result.tasks and not result.needs_review:
        result.needs_review.append({"reason": "Действия не распознаны", "source_quote": body[:400]})

    # Дедупликация по нормализованному заголовку внутри результата
    seen: set[str] = set()
    unique: list[ExtracteedTask] = []
    for task in result.tasks:
        key = normalize_title(task.title)
        if key in seen:
            continue
        seen.add(key)
        unique.append(task)
    result.tasks = unique[:6]
    return result


NEGATORS_LOCAL = ("не надо", "не нужно", "не звонить", "не отправлять", "отменить", "отменяем")


def extract_payment_word(low: str) -> bool:
    return any(w in low for w in ("оплат", "плат", "долг", "задолжен", "счёт", "счет"))


def normalize_title(title: str) -> str:
    low = re.sub(r"[^\w\s]", "", (title or "").lower())
    low = re.sub(r"\s+", " ", low).strip()
    return low[:160]


def make_dedupe_key(client_id: str, title: str, due_at: datetime | None) -> str:
    raw = f"{client_id}|{normalize_title(title)}|{due_at.date().isoformat() if due_at else 'none'}"
    return hashlib.sha256(raw.encode()).hexdigest()[:40]


def _parse_iso(value: Any) -> datetime | None:
    if not value or not isinstance(value, str) or value.lower() == "null":
        return None
    try:
        text = value.replace("Z", "+00:00")
        if len(text) == 10:
            text += "T10:00:00"
        parsed = datetime.fromisoformat(text)
        return parsed
    except ValueError:
        return None


def _normalize_payload(payload: dict[str, Any], note_moment: datetime, tz_name: str) -> ExtractionResult:
    result = ExtractionResult(model=settings.ai_model, offline=False)
    now_local = localize(note_moment, tz_name)

    for raw in payload.get("tasks", [])[:8]:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()
        if not title:
            continue
        due_raw = raw.get("due_date")
        due_time = raw.get("due_time") or "10:00"
        due_at: datetime | None = None
        parsed = _parse_iso(due_raw if isinstance(due_raw, str) and len(str(due_raw)) == 10
                            else (f"{due_raw}T{due_time}" if due_raw else None))
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=now_local.tzinfo)
            due_at = utc_naive(parsed)
        else:
            # AI не дал дату — пробуем локальные правила по цитате
            due_at, _ = extract_due(str(raw.get("source_quote") or title), now_local, tz_name)

        priority = str(raw.get("priority") or "normal").lower()
        if priority not in ("low", "normal", "high", "critical"):
            priority = "normal"

        confidence = raw.get("confidence")
        try:
            confidence = float(confidence) if confidence is not None else None
        except (TypeError, ValueError):
            confidence = None

        result.tasks.append(
            ExtracteedTask(
                title=title[:200],
                action_type=str(raw.get("action_type") or detect_action_type(title))[:32],
                due_at=due_at,
                priority=priority,
                conditional=bool(raw.get("conditional")),
                source_quote=str(raw.get("source_quote") or "")[:2000],
                confidence=confidence,
            )
        )

    for raw in payload.get("commitments", [])[:6]:
        if not isinstance(raw, dict):
            continue
        description = str(raw.get("description") or "").strip()
        if not description:
            continue
        promised_by = str(raw.get("promised_by") or "client").lower()
        if promised_by not in ("client", "us"):
            promised_by = "client"
        due_at, _ = extract_due(str(raw.get("due_date") or description), now_local, tz_name)
        result.commitments.append(
            ExtracteedCommitment(
                promised_by=promised_by,
                description=description[:500],
                due_at=due_at,
                source_quote=str(raw.get("source_quote") or "")[:2000],
            )
        )

    for raw in payload.get("needs_review", [])[:8]:
        if isinstance(raw, dict) and raw.get("reason"):
            result.needs_review.append({
                "reason": str(raw["reason"])[:300],
                "source_quote": str(raw.get("source_quote") or "")[:1000],
            })
    return result


def _balance_json(fragment: str) -> str:
    """Дописывает недостающие закрывающие символы для обрезанного JSON."""
    depth_curly = 0
    depth_square = 0
    in_string = False
    escape = False

    for char in fragment:
        if escape:
            escape = False
            continue
        if char == "\\":
            escape = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth_curly += 1
        elif char == "}":
            depth_curly -= 1
        elif char == "[":
            depth_square += 1
        elif char == "]":
            depth_square -= 1

    repaired = fragment
    if in_string:
        repaired += '"'
    # Убираем возможный «хвост» после последней запятой/двоеточия
    repaired = repaired.rstrip()
    while repaired and repaired[-1] in ",:":
        repaired = repaired[:-1].rstrip()
    repaired += "]" * max(0, depth_square) + "}" * max(0, depth_curly)
    return repaired


def _strip_json(text: str) -> dict[str, Any] | None:
    """Достаёт JSON-объект даже из ответа с обёрткой, рассуждениями или обрывом."""
    if not text:
        return None

    cleaned = text.strip()
    # Снимаем markdown-обёртку
    cleaned = re.sub(r"^```(?:json|JSON)?\s*", "", cleaned)
    cleaned = re.sub(r"```\s*$", "", cleaned)
    cleaned = cleaned.strip()

    candidates: list[str] = []

    start = cleaned.find("{")
    if start != -1:
        candidates.append(cleaned[start:])
        end = cleaned.rfind("}")
        if end > start:
            candidates.append(cleaned[start:end + 1])

    # Каждый кандидат пробуем как есть, затем — «починенным»
    for candidate in candidates:
        for variant in (candidate, _balance_json(candidate)):
            try:
                parsed = json.loads(variant)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                continue

    # Последняя попытка: вытащить массив tasks из сырого текста
    match = re.search(r'"tasks"\s*:\s*(\[.*)', cleaned, re.DOTALL)
    if match:
        fragment = '{"tasks":' + match.group(1)
        for variant in (fragment, _balance_json(fragment)):
            try:
                parsed = json.loads(variant)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                continue

    return None


def _build_payload(body: str, note_moment: datetime, tz_name: str, json_mode: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": settings.ai_model,
        "temperature": settings.ai_temperature,
        "max_tokens": settings.ai_max_tokens,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Часовой пояс менеджера: {tz_name}\n"
                    f"Время заметки: {localize(note_moment, tz_name).isoformat()}\n"
                    f"Текст заметки:\n{body}"
                ),
            },
        ],
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    return payload


def extract(body: str, note_moment: datetime, tz_name: str) -> ExtractionResult:
    """Главная точка входа. Никогда не бросает исключений наружу.

    Провайдер — любой OpenAI-совместимый endpoint:
    RouterAI (https://routerai.ru/api/v1), OpenRouter и другие.
    """
    if not settings.ai_enabled or not settings.ai_api_key:
        log.info("AI: локальный экстрактор (ключ провайдера не задан)")
        return local_extract(body, note_moment, tz_name)

    headers = {
        "Authorization": f"Bearer {settings.ai_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": settings.ai_referer,
        "X-Title": "ForteOn Extractor",
    }
    endpoint = f"{settings.ai_base_url}/chat/completions"

    last_error = "неизвестная ошибка"
    json_mode = settings.ai_json_mode

    for attempt in range(settings.ai_max_retries + 1):
        payload = _build_payload(body, note_moment, tz_name, json_mode)
        try:
            with httpx.Client(timeout=settings.ai_timeout_seconds) as client:
                response = client.post(endpoint, headers=headers, json=payload)
            if response.status_code >= 400:
                text = response.text[:400]
                last_error = f"HTTP {response.status_code}: {text}"
                log.warning("AI: попытка %s неудачна — %s", attempt + 1, last_error)
                # Провайдер не поддерживает json_object — повторяем без него
                if json_mode and response.status_code in (400, 422) and "response_format" in text.lower():
                    json_mode = False
                    log.info("AI: отключаю response_format=json_object (не поддерживается провайдером)")
                continue

            data = response.json()
            message = (data.get("choices") or [{}])[0].get("message") or {}
            content = message.get("content") or ""
            if isinstance(content, list):  # некоторые провайдеры отдают массив частей
                content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
            parsed = _strip_json(str(content))
            if not parsed:
                last_error = "Ответ модели не является JSON"
                log.warning("AI: попытка %s — %s; ответ: %s", attempt + 1, last_error, str(content)[:200])
                continue

            result = _normalize_payload(parsed, note_moment, tz_name)
            usage = data.get("usage") or {}
            result.tokens = usage.get("total_tokens")
            result.cost = usage.get("total_cost") or None
            log.info(
                "AI: ok model=%s задач=%s обязательств=%s токенов=%s",
                settings.ai_model, len(result.tasks), len(result.commitments), result.tokens,
            )
            return result
        except Exception as exc:  # network/timeout/parsing
            last_error = f"{type(exc).__name__}: {exc}"
            log.warning("AI: исключение на попытке %s — %s", attempt + 1, last_error)

    fallback = local_extract(body, note_moment, tz_name)
    fallback.model = "local-rules-fallback"
    fallback.error = last_error
    return fallback


def ping() -> dict[str, Any]:
    """Проверка провайдера (health/админка).

    1) GET /models — если поддерживается;
    2) иначе минимальный chat-запрос с max_tokens=1.
    """
    provider = {"provider": settings.ai_base_url, "model": settings.ai_model}
    if not settings.ai_api_key:
        return {"ok": False, "reason": "no_api_key", **provider}

    headers = {
        "Authorization": f"Bearer {settings.ai_api_key}",
        "Content-Type": "application/json",
    }
    timeout = min(settings.ai_timeout_seconds, 25)

    try:
        with httpx.Client(timeout=timeout) as client:
            listing = client.get(f"{settings.ai_base_url}/models", headers=headers)
            if listing.status_code < 400:
                return {"ok": True, "status": listing.status_code, "mode": "models", **provider}

            probe = client.post(
                f"{settings.ai_base_url}/chat/completions",
                headers=headers,
                json={
                    "model": settings.ai_model,
                    "max_tokens": 1,
                    "messages": [{"role": "user", "content": "ping"}],
                },
            )
            if probe.status_code < 400:
                return {"ok": True, "status": probe.status_code, "mode": "chat", **provider}

            return {
                "ok": False,
                "status": probe.status_code,
                "mode": "chat",
                "reason": probe.text[:300],
                **provider,
            }
    except Exception as exc:
        return {"ok": False, "reason": f"{type(exc).__name__}: {exc}", **provider}
