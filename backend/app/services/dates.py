"""Нормализация дат из заметок (раздел 02 спецификации).

Правила:
* явная дата (2026-11-20, 20.11.2026, «20 ноября») — задача с точным сроком;
* относительные («завтра», «послезавтра», «в пятницу», «через 3 дня») считаются
  от времени исходной заметки в часовом поясе менеджера;
* если дату определить нельзя — due_at = None, задача уходит в «Уточнить»,
  вымышленный дедлайн НЕ создаётся.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6,
    "июля": 7, "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
    "январь": 1, "февраль": 2, "март": 3, "апрель": 4, "май": 5, "июнь": 6,
    "июль": 7, "август": 8, "сентябрь": 9, "октябрь": 10, "ноябрь": 11, "декабрь": 12,
}

WEEKDAYS = {
    "понедельник": 0, "вторник": 1, "среду": 2, "среда": 2, "четверг": 3,
    "пятницу": 4, "пятница": 4, "субботу": 5, "суббота": 5, "воскресенье": 6,
}

# Слова-маркеры отсутствия срока и отрицания
NO_DEADLINE = ("без срока", "не срочно", "когда-нибудь", "когда получится", "без спешки", "нет срока")
NEGATORS = ("не надо", "не нужно", "не будем", "не звонить", "не отправлять", "отменил", "отменили", "отменяем")
CONDITIONAL_MARKERS = ("если", "при условии", "в случае", "как только", "после того как", "when")


# Запасные смещения для окружений без tzdata (Windows без пакета tzdata)
_FALLBACK_OFFSETS = {
    "asia/yekaterinburg": 5,
    "asia/yekaterinburg_custom": 5,
    "asia/novosibirsk": 7,
    "europe/moscow": 3,
    "utc": 0,
}


def get_tz(name: str | None, fallback: str = "Asia/Yekaterinburg") -> timezone:
    """ZoneInfo при наличии tzdata, иначе timezone с фиксированным смещением."""
    for candidate in (name, fallback, "UTC"):
        if not candidate:
            continue
        try:
            return ZoneInfo(candidate)
        except (ZoneInfoNotFoundError, ValueError, ModuleNotFoundError):
            offset = _FALLBACK_OFFSETS.get(candidate.strip().lower())
            if offset is not None:
                return timezone(timedelta(hours=offset), candidate)
            continue
    return timezone(timedelta(0), "UTC")


def localize(moment: datetime | None, tz_name: str | None) -> datetime:
    tz = get_tz(tz_name)
    if moment is None:
        moment = datetime.now(tz)
    elif moment.tzinfo is None:
        moment = moment.replace(tzinfo=tz)
    else:
        moment = moment.astimezone(tz)
    return moment


def utc_naive(moment: datetime) -> datetime:
    """В БД храним UTC без tzinfo (совместимо с SQLite и PostgreSQL)."""
    if moment.tzinfo is not None:
        return moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment


DATE_FORMATS = ("%d.%m.%Y", "%d.%m.%y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d %m %Y")


def parse_explicit_date(text: str, reference: date | None = None) -> date | None:
    """Ищет абсолютную дату. Год без явного указания берёт из даты заметки."""
    reference = reference or date.today()

    def with_optional_year(day: int, month: int, text_year: str | None) -> date:
        if text_year is not None:
            year = int(text_year) + (2000 if len(text_year) == 2 else 0)
            return date(year, month, day)
        result = date(reference.year, month, day)
        return result if result >= reference else date(reference.year + 1, month, day)

    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None

    m = re.search(r"\b(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?\b", text)
    if m:
        day = int(m.group(1))
        month = int(m.group(2))
        year_raw = m.group(3)
        if 1 <= day <= 31 and 1 <= month <= 12:
            try:
                return with_optional_year(day, month, year_raw)
            except ValueError:
                return None

    m = re.search(r"\b(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?", text.lower())
    if m and m.group(2) in MONTHS:
        day = int(m.group(1))
        month = MONTHS[m.group(2)]
        try:
            return with_optional_year(day, month, m[3])
        except ValueError:
            return None
    return None


def parse_relative_date(text: str, reference: datetime) -> date | None:
    low = text.lower()

    if "послезавтра" in low:
        return (reference + timedelta(days=2)).date()
    if "завтра" in low:
        return (reference + timedelta(days=1)).date()
    if "сегодня" in low or "сейчас" in low:
        return reference.date()

    m = re.search(r"через\s+(\d+|один|одну|два|две|три|четыре|пять|шесть|семь)\s+"
                  r"(день|дня|дней|недел\w*|месяц\w*|год\w*)", low)
    if m:
        amount_raw = m.group(1)
        words = {"один": 1, "одну": 1, "два": 2, "две": 2, "три": 3, "четыре": 4,
                 "пять": 5, "шесть": 6, "семь": 7}
        amount = int(amount_raw) if amount_raw.isdigit() else words.get(amount_raw, 1)
        unit = m.group(2)
        if unit.startswith("д"):
            return (reference + timedelta(days=amount)).date()
        if unit.startswith("недел"):
            return (reference + timedelta(weeks=amount)).date()
        if unit.startswith("месяц"):
            return (reference + timedelta(days=30 * amount)).date()
        if unit.startswith("год"):
            return (reference + timedelta(days=365 * amount)).date()

    m = re.search(r"(?:до|к)\s+конца\s+(недели|месяца|квартала|года)", low)
    if m:
        unit = m.group(1)
        if unit == "недели":
            return (reference + timedelta(days=6 - reference.weekday())).date()
        if unit == "месяца":
            next_month = (reference.replace(day=28) + timedelta(days=4)).replace(day=1)
            return next_month - timedelta(days=1)
        if unit == "квартала":
            quarter_end_month = ((reference.month - 1) // 3 + 1) * 3
            next_month = date(reference.year + (1 if quarter_end_month == 12 else 0),
                              1 if quarter_end_month == 12 else quarter_end_month + 1, 1)
            return next_month - timedelta(days=1)
        if unit == "года":
            return date(reference.year, 12, 31)

    for word, weekday in WEEKDAYS.items():
        if re.search(rf"(?:в|во|к|до)\s+{word}", low):
            delta = (weekday - reference.weekday()) % 7
            if delta == 0:
                delta = 7
            return (reference + timedelta(days=delta)).date()

    m = re.search(r"(?:следующ\w+|на следующей)\s+неделе", low)
    if m:
        return (reference + timedelta(days=7)).date()
    m = re.search(r"(?:на этой|до конца) неделе", low)
    if m:
        return (reference + timedelta(days=6 - reference.weekday())).date()
    if "в начале недели" in low:
        return (reference + timedelta(days=(7 - reference.weekday()) % 7)).date()

    return None


def extract_due(text: str, note_moment: datetime, tz_name: str | None) -> tuple[datetime | None, str]:
    """Возвращает (due_at UTC naive, причина). Причина — 'explicit'|'relative'|'none'|'blocked'."""
    local_ref = localize(note_moment, tz_name)
    low = (text or "").lower()

    if any(marker in low for marker in NO_DEADLINE):
        return None, "none"

    explicit = parse_explicit_date(text, local_ref.date())
    day = explicit or parse_relative_date(text, local_ref)
    if day is not None:
        match = re.search(r"\b([01]?\d|2[0-3]):([0-5]\d)\b", text)
        hour, minute = (int(match[1]), int(match[2])) if match else (10, 0)
        local_due = datetime(day.year, day.month, day.day, hour, minute, tzinfo=local_ref.tzinfo)
        return utc_naive(local_due), "explicit" if explicit else "relative"

    return None, "none"


def is_negative(text: str) -> bool:
    low = (text or "").lower()
    return any(marker in low for marker in NEGATORS)


def is_conditional(text: str) -> bool:
    low = (text or "").lower()
    return any(marker in low for marker in CONDITIONAL_MARKERS)


def to_date(due_at: datetime | None, tz_name: str | None = None) -> date | None:
    if due_at is None:
        return None
    if tz_name:
        instant = due_at if due_at.tzinfo else due_at.replace(tzinfo=timezone.utc)
        return instant.astimezone(get_tz(tz_name)).date()
    return due_at.date()
