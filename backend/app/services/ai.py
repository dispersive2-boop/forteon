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

PROMPT_VERSION = "v3"

SYSTEM_PROMPT = """Ты — экстрактор задач для CRM сопровождения клиентов.

Задача: разделить текст заметки на ТРИ типа событий и определить сроки.

1) DONE — уже сделано: «отправил», «согласовали», «обсудили», «встретились»,
   «подписали», «оплатили», «проверил». Такое НЕ становится задачей.
   Оно идёт в completed — как факт истории.
2) TODO — нам предстоит сделать. Сюда же относится будущее время от первого
   лица («позвоню», «отправлю») и инфинитив («отправить КП»).
3) WAITING — ждём от клиента или третьей стороны: «ждём», «обещали»,
   «попросили», «должны со стороны клиента», «нет ответа».

Отсутствие даты не повод отправлять задачу на уточнение: ставь due_date=null.
Сначала реши, требуется ли действие, потом извлеки срок. Срок указывай в
часовом поясе менеджера. Если в заметке указано время, передай его как HH:MM;
если время не указано, передай due_time=null.
Примеры:
- «КП отправил, смету переделать завтра к 09:45» — факт отправки и одна задача
  на переделку со сроком завтра, 09:45.
- «Клиент обещал оплатить к пятнице» — задача контроля и обязательство клиента.
- «Проверить документы» — задача без срока.


Верни СТРОГО JSON без markdown:
{"tasks":[{"title":"","event_kind":"todo|waiting|unclear","actor":"us|client",
"action_type":"call|email|meeting|document|payment|other",
"due_date":"YYYY-MM-DD|null","due_time":"HH:MM|null",
"priority":"low|normal|high|critical","conditional":false,
"source_quote":"","confidence":0.0}],
"commitments":[{"promised_by":"client|us","description":"","due_date":"YYYY-MM-DD|null","source_quote":""}],
"completed":[{"description":"","source_quote":""}],
"needs_review":[{"reason":"конкретный вопрос менеджеру","source_quote":""}]}

Жёсткие правила:
* Не выдумывай даты, исполнителей, суммы и обещания, которых нет в тексте.
* Различай дату события («вчера созвонились») и дедлайн задачи («до пятницы»).
  Дата уже случившегося события дедлайном не является.
* event_kind=unclear ставь только если действительно не понять: сделано уже
  или предстоит. Тогда в needs_review напиши КОНКРЕТНЫЙ вопрос, например
  «Документ уже отправлен или его ещё нужно подготовить?», а не «уточните».
* Отрицания («не звонить») и условные («если оплатят») — conditional=true.
* source_quote — дословный фрагмент заметки. Без него задача не принимается.
* Максимум 6 задач. Только то, что явно следует из текста."""

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
    # Тип события (events.py): todo | waiting | unclear.
    # Раньше тип не различался, и «Отправил КП» становилось задачей.
    event_kind: str = "todo"
    actor: str = "us"
    # Конкретный вопрос при уточнении (п.14).
    review_question: str | None = None
    # Почему срок такой (или почему его нет) — для показа менеджеру.
    due_reason: str | None = None


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
    # Уже выполненные действия. Задачами не становятся — идут в историю
    # заметки, чтобы факт не потерялся (п.7), но и не всплыл как «надо».
    completed: list[dict[str, Any]] = field(default_factory=list)
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
    """Детерминированный экстрактор без внешних вызовов.

    Срок определяется ОТДЕЛЬНО от действия (п.1). Отсутствие даты больше не
    отправляет задачу в «Уточнить»: в уточнение попадает только неясный тип
    события — когда непонятно, сделано уже или предстоит.

    Тип события даёт events.classify():
      DONE    — задача не создаётся, факт пишется в историю заметки (п.4, 7);
      TODO    — задача менеджеру;
      WAITING — задача контроля ожидания + обязательство клиента (п.8, 9);
      UNCLEAR — на уточнение с конкретным вопросом (п.13, 14);
      fact    — ничего.
    """
    from .events import DONE, TODO, UNCLEAR, WAITING, classify, review_question

    result = ExtractionResult(model="local-rules")
    now_local = localize(note_moment, tz_name)

    for sentence in _sentences(body):
        event = classify(sentence)
        due_at, due_reason = extract_due(sentence, now_local, tz_name)
        has_due = due_at is not None

        # --- уже сделано: в историю, задачу не создаём (п.4, 7) ---
        if event.kind == DONE:
            result.completed.append({
                "description": event.done_phrase or sentence,
                "source_quote": sentence,
            })
            continue

        if event.kind == "fact":
            continue

        # --- ожидание от клиента (п.8, 9) ---
        if event.kind == WAITING:
            result.commitments.append(
                ExtracteedCommitment(
                    promised_by=event.actor,
                    description=_title_from(sentence),
                    due_at=due_at,
                    source_quote=sentence,
                )
            )
            result.tasks.append(
                ExtracteedTask(
                    title=f"Проконтролировать: {_title_from(sentence)}",
                    action_type="payment" if extract_payment_word(sentence.lower()) else "other",
                    due_at=due_at,
                    priority="high",
                    conditional=is_conditional(sentence),
                    source_quote=sentence,
                    confidence=event.confidence,
                    event_kind=WAITING,
                    actor=event.actor,
                    due_reason=due_reason,
                )
            )
            continue

        # --- непонятно: сделано или предстоит (п.13, 14) ---
        if event.kind == UNCLEAR:
            question = review_question(event)
            result.tasks.append(
                ExtracteedTask(
                    title=_title_from(sentence),
                    action_type=detect_action_type(sentence),
                    due_at=due_at,
                    priority=detect_priority(sentence),
                    conditional=is_conditional(sentence),
                    source_quote=sentence,
                    confidence=event.confidence,
                    event_kind=UNCLEAR,
                    actor=event.actor,
                    review_question=question,
                    due_reason=due_reason,
                )
            )
            result.needs_review.append({"reason": question, "source_quote": sentence})
            continue

        # --- надо сделать (п.2: без срока — всё равно задача) ---
        result.tasks.append(
            ExtracteedTask(
                title=_title_from(sentence),
                action_type=detect_action_type(sentence),
                due_at=due_at,
                priority=detect_priority(sentence),
                conditional=is_conditional(sentence),
                source_quote=sentence,
                confidence=event.confidence,
                event_kind=TODO,
                actor="us",
                due_reason=due_reason,
            )
        )

    if not result.tasks and not result.completed:
        result.needs_review.append({
            "reason": "Действий не найдено: в заметке только информация",
            "source_quote": body[:400],
        })

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


def make_dedupe_key(
    client_id: str,
    title: str,
    due_at: datetime | None,
    note_id: str | None = None,
) -> str:
    """Ключ дедупликации задачи.

    note_id входит в ключ намеренно. Раньше ключ был
    client|title|date, поэтому второе «созвонился» по тому же клиенту
    в другой день с той же формулировкой молча отбрасывалось — законный
    повтор считался дублем (п.22).

    Теперь:
      * повторная обработка ТОЙ ЖЕ заметки даёт тот же ключ → копий нет (п.21);
      * то же действие из НОВОЙ заметки даёт другой ключ → задача создаётся.
    """
    parts = [client_id, normalize_title(title),
             due_at.date().isoformat() if due_at else "none"]
    if note_id:
        parts.append(note_id)
    raw = "|".join(parts)
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
        due_time = str(raw.get("due_time") or "10:00")
        due_at: datetime | None = None
        date_value = str(due_raw or "")
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_value):
            parsed = _parse_iso(f"{date_value}T{due_time}") or _parse_iso(f"{date_value}T10:00")
        else:
            parsed = _parse_iso(date_value)
        if parsed is not None:
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=now_local.tzinfo)
            due_at = utc_naive(parsed)
        else:
            due_at, _ = extract_due(str(raw.get("source_quote") or title), now_local, tz_name)

        priority = str(raw.get("priority") or "normal").lower()
        if priority not in ("low", "normal", "high", "critical"):
            priority = "normal"

        confidence = raw.get("confidence")
        try:
            confidence = float(confidence) if confidence is not None else None
        except (TypeError, ValueError):
            confidence = None

        # Модель может вернуть тип события сама. Если не вернула — определяем
        # локально по цитате: иначе «Отправил КП» от модели снова станет задачей.
        from .events import classify

        quote = str(raw.get("source_quote") or title)
        event = classify(quote)
        kind = str(raw.get("event_kind") or "").lower()
        if kind not in ("todo", "waiting", "unclear", "done", "fact"):
            kind = event.kind

        # Выполненное действием не считаем: задача не нужна, факт в историю.
        if kind in ("done", "fact"):
            result.completed.append({
                "description": quote[:500],
                "source_quote": quote[:2000],
            })
            continue

        actor = str(raw.get("actor") or "").lower()
        if actor not in ("us", "client"):
            actor = event.actor

        question = str(raw.get("review_question") or "").strip()[:300] or None
        if kind == "unclear" and not question:
            from .events import review_question

            question = review_question(event)

        result.tasks.append(
            ExtracteedTask(
                title=title[:200],
                action_type=str(raw.get("action_type") or detect_action_type(title))[:32],
                due_at=due_at,
                priority=priority,
                conditional=bool(raw.get("conditional")),
                source_quote=quote[:2000],
                confidence=confidence,
                event_kind=kind,
                actor=actor,
                review_question=question,
                due_reason=raw.get("due_reason"),
            )
        )

        if kind == "waiting" and not any(
            c.source_quote == quote for c in result.commitments
        ):
            result.commitments.append(
                ExtracteedCommitment(
                    promised_by=actor,
                    description=title[:500],
                    due_at=due_at,
                    source_quote=quote[:2000],
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
            raw_content = str(content)
            parsed = _strip_json(raw_content)
            if not parsed:
                last_error = "Ответ модели не является JSON"
                # Сырой ответ в лог: без него «не JSON» — диагноз без улик.
                # 500 символов достаточно, чтобы увидеть, что именно вернул провайдер
                # (рассуждения, извинения, HTML-ошибку). Секретов в ответе модели нет.
                log.warning(
                    "AI: попытка %s — %s; сырой ответ (%s симв.): %r",
                    attempt + 1, last_error, len(raw_content), raw_content[:500],
                )
                # Модель начала с рассуждений и не отдала JSON — повторяем без
                # response_format: иногда это единственный способ получить объект.
                if json_mode:
                    json_mode = False
                    log.info("AI: повтор без response_format после невалидного JSON")
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


def provider_failure_message(error: str | None) -> str:
    """Короткая причина для интерфейса, без тела ответа провайдера."""
    error = error or ""
    status_match = re.match(r"HTTP (\d{3})\b", error)
    if status_match:
        status = int(status_match.group(1))
        if status in (401, 403):
            return "Провайдер отклонил доступ. Проверьте ключ и права на модель."
        if status == 402:
            return "Провайдер вернул ошибку оплаты. Проверьте баланс."
        if status == 429:
            return "Достигнут лимит запросов у провайдера. Повторите позже."
        if status in (400, 404, 422):
            return "Провайдер отклонил запрос к выбранной модели."
        if status >= 500:
            return "На стороне провайдера произошла ошибка. Повторите позже."
    if "timeout" in error.lower():
        return "Провайдер не ответил вовремя."
    if error.startswith(("Ответ модели", "JSONDecodeError")):
        return "Модель вернула ответ в неожиданном формате."
    return "Не удалось получить ответ от модели."


def ping() -> dict[str, Any]:
    """Проверяет вызов выбранной модели без отправки клиентских данных."""
    provider = {"provider": settings.ai_base_url, "model": settings.ai_model}
    if not settings.ai_enabled:
        return {"ok": False, "reason": "disabled", "message": "Разбор моделью выключен.", **provider}
    if not settings.ai_api_key:
        return {"ok": False, "reason": "no_api_key", "message": "Ключ провайдера не задан.", **provider}

    result: dict[str, Any] = {"mode": "chat", **provider}
    headers = {
        "Authorization": f"Bearer {settings.ai_api_key}",
        "HTTP-Referer": settings.ai_referer,
        "X-Title": "ForteOn Extractor",
    }
    timeout = min(settings.ai_timeout_seconds, 25)
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                f"{settings.ai_base_url}/chat/completions",
                headers=headers,
                json={
                    "model": settings.ai_model,
                    "max_tokens": 32,
                    "messages": [{"role": "user", "content": "Reply with OK."}],
                },
            )
    except httpx.RequestError as exc:
        return {"ok": False, "message": provider_failure_message(type(exc).__name__), **result}

    result["status"] = response.status_code
    if not response.is_success:
        return {
            "ok": False,
            "message": provider_failure_message(f"HTTP {response.status_code}"),
            **result,
        }

    try:
        data = response.json()
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("choices"), list) and data["choices"]:
        choice = data["choices"][0]
        if isinstance(choice, dict):
            message = choice.get("message")
            if isinstance(message, dict) and (message.get("content") or message.get("reasoning_content")):
                return {"ok": True, **result}
    return {
        "ok": False,
        "message": provider_failure_message("Ответ модели в неожиданном формате"),
        **result,
    }
