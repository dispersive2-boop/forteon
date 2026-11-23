"""Сводка разбора одной строкой (п.2 «30 идей»).

Проверяем то, что видит менеджер: числа и саму строку. Склонения —
частая ошибка («2 задача»), поэтому они покрыты отдельно.
"""

from __future__ import annotations

from app.services.summary import build_summary


def test_empty_note_has_no_headline() -> None:
    """Пустой разбор не должен показывать «0 задач» — это шум."""
    summary = build_summary(tasks=[], completed=[], questions=[])

    assert summary.headline == ""
    assert summary.has_details is False
    assert (summary.tasks, summary.waiting, summary.completed, summary.questions) == (0, 0, 0, 0)


def test_two_tasks_one_waiting_one_question() -> None:
    """Пример из ТЗ: «2 задачи · 1 ожидание · 1 вопрос»."""
    tasks = [
        {"title": "Позвонить", "event_kind": "todo"},
        {"title": "Ждём реквизиты", "event_kind": "waiting"},
    ]
    summary = build_summary(tasks=tasks, questions=[{"question": "Счёт отправлен?"}])

    assert summary.headline == "1 задача · 1 ожидание · 1 вопрос"
    assert summary.tasks == 1, "ожидание контроля не считается обычной задачей"
    assert summary.waiting == 1
    assert summary.questions == 1
    assert summary.has_details is True


def test_only_tasks() -> None:
    summary = build_summary(tasks=[{"event_kind": "todo"}, {"event_kind": "todo"}])

    assert summary.headline == "2 задачи"
    assert summary.waiting == 0


def test_only_completed_actions() -> None:
    """«Отправил КП» — не задача, но и молчать о нём нельзя."""
    summary = build_summary(completed=[{"text": "Отправил КП"}])

    assert summary.headline == "1 выполнено"
    assert summary.tasks == 0


def test_plural_forms() -> None:
    """Русские склонения: 1 задача, 2 задачи, 5 задач."""
    cases = [
        (1, "1 задача"),
        (2, "2 задачи"),
        (3, "3 задачи"),
        (4, "4 задачи"),
        (5, "5 задач"),
        (11, "11 задач"),
        (12, "12 задач"),
        (21, "21 задача"),
        (22, "22 задачи"),
        (25, "25 задач"),
    ]
    for count, expected in cases:
        summary = build_summary(tasks=[{"event_kind": "todo"} for _ in range(count)])
        assert summary.headline == expected, f"для {count} ожидалось «{expected}»"


def test_waiting_plural() -> None:
    cases = [
        (1, "1 ожидание"),
        (2, "2 ожидания"),
        (5, "5 ожиданий"),
        (11, "11 ожиданий"),
    ]
    for count, expected in cases:
        summary = build_summary(tasks=[{"event_kind": "waiting"} for _ in range(count)])
        assert summary.headline == expected, f"для {count} ожидалось «{expected}»"


def test_questions_plural() -> None:
    cases = [(1, "1 вопрос"), (2, "2 вопроса"), (5, "5 вопросов")]
    for count, expected in cases:
        summary = build_summary(questions=count)
        assert summary.headline == expected


def test_waiting_not_double_counted() -> None:
    """Ожидание — это задача контроля, но в строке оно отдельно, без дубля."""
    tasks = [
        {"event_kind": "todo"},
        {"event_kind": "waiting"},
        {"event_kind": "waiting"},
    ]
    summary = build_summary(tasks=tasks)

    assert summary.tasks == 1
    assert summary.waiting == 2
    assert summary.headline == "1 задача · 2 ожидания"


def test_unknown_event_kind_counts_as_task() -> None:
    """Если тип не распознан — считаем задачей, а не теряем из счёта."""
    summary = build_summary(tasks=[{"title": "что-то"}, {}])

    assert summary.tasks == 2
    assert summary.waiting == 0


def test_explicit_waiting_overrides_detection() -> None:
    """Явное число ожиданий важнее вычисленного по event_kind."""
    summary = build_summary(tasks=[{"event_kind": "todo"}], waiting=3)

    assert summary.waiting == 3
    assert summary.headline == "3 ожидания"
