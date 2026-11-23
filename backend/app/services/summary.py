"""Сводка разбора заметки одной строкой (п.2 «30 идей»).

Менеджер после диктовки не должен читать список сущностей — ему достаточно
«2 задачи · 1 ожидание · 1 вопрос» и возможности раскрыть детали.

Правила подсчёта живут здесь, а не во фронтенде: тогда строка и числа
не разъедутся, и их можно проверить тестами без запуска браузера.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from ..schemas import ExtractionSummaryOut


def _plural(count: int, one: str, few: str, many: str) -> str:
    """Русское склонение по числу: 1 задача, 2 задачи, 5 задач."""
    if count % 10 == 1 and count % 100 != 11:
        return one
    if 2 <= count % 10 <= 4 and not 12 <= count % 100 <= 14:
        return few
    return many


def build_summary(
    tasks: Iterable[Mapping[str, Any] | Any] = (),
    completed: Iterable[Any] = (),
    questions: Iterable[Any] | int = (),
    waiting: int | None = None,
) -> ExtractionSummaryOut:
    """Собрать сводку из результатов разбора.

    tasks — задачи, созданные из заметки (dict из result_json или ORM-объекты);
    completed — уже выполненные действия (в задачи они не превращаются);
    questions — неоднозначные места, по которым нужен ответ менеджера;
    waiting — сколько задач ждут клиента. Если не передано, считается по
    event_kind == "waiting" среди tasks.
    """
    task_list = list(tasks)
    waiting_count = (
        waiting
        if waiting is not None
        else sum(1 for t in task_list if _event_kind(t) == "waiting")
    )
    # Ожидания контроля — это тоже задачи, поэтому в общий счёт они уже входят.
    delivered = max(len(task_list) - waiting_count, 0)
    completed_count = len(list(completed))
    question_count = questions if isinstance(questions, int) else len(list(questions))

    parts: list[str] = []
    if delivered:
        parts.append(f"{delivered} {_plural(delivered, 'задача', 'задачи', 'задач')}")
    if waiting_count:
        parts.append(
            f"{waiting_count} {_plural(waiting_count, 'ожидание', 'ожидания', 'ожиданий')}"
        )
    if completed_count:
        parts.append(
            f"{completed_count} {_plural(completed_count, 'выполнено', 'выполнено', 'выполнено')}"
        )
    if question_count:
        parts.append(
            f"{question_count} {_plural(question_count, 'вопрос', 'вопроса', 'вопросов')}"
        )

    has_details = bool(parts)
    return ExtractionSummaryOut(
        tasks=delivered,
        waiting=waiting_count,
        completed=completed_count,
        questions=question_count,
        headline=" · ".join(parts) if parts else "",
        has_details=has_details,
    )


def _event_kind(task: Mapping[str, Any] | Any) -> str | None:
    if isinstance(task, Mapping):
        kind = task.get("event_kind")
    else:
        kind = getattr(task, "event_kind", None)
    return kind if isinstance(kind, str) else None
