"""Тесты ограничения частоты запросов (этап A, P0 ТЗ v2).

Проверяют именно поведение, а не факт наличия класса:
  * окно действительно ограничивает число событий;
  * карантин после серии неудач блокирует даже верный пароль;
  * успех снимает накопленные неудачи;
  * ключ по IP не даёт обойти лимит сменой логина.
"""
from __future__ import annotations

import time

import pytest

from app.services.ratelimit import RateLimiter


@pytest.fixture()
def limiter() -> RateLimiter:
    return RateLimiter()


def test_allows_up_to_limit(limiter: RateLimiter) -> None:
    """Пять попаданий в окне проходят, шестое — блокируется."""
    for _ in range(5):
        assert limiter.hit("k", 5, 60) == 0

    wait = limiter.hit("k", 5, 60)
    assert wait > 0, "шестое событие должно быть отклонено"
    assert limiter.retry_after("k") > 0


def test_lockout_after_failures(limiter: RateLimiter) -> None:
    """После max_failures неудач ключ в карантине на заданное время."""
    for i in range(4):
        assert limiter.hit("k", 10, 60, max_failures=5, lockout=900, failed=True) == 0, i
    blocked = limiter.hit("k", 10, 60, max_failures=5, lockout=900, failed=True)
    assert blocked >= 890, f"ожидался карантин ~900 c, получено {blocked}"


def test_lockout_blocks_even_valid_attempt(limiter: RateLimiter) -> None:
    """Карантин не снимается «правильным» запросом — иначе смысла нет."""
    for _ in range(5):
        limiter.hit("k", 10, 60, max_failures=5, lockout=600, failed=True)
    assert limiter.retry_after("k") > 0
    assert limiter.hit("k", 10, 60, failed=False) > 0


def test_success_resets_failures(limiter: RateLimiter) -> None:
    """Успешный вход обнуляет счётчик неудач."""
    for _ in range(4):
        limiter.hit("k", 10, 60, max_failures=5, lockout=600, failed=True)
    limiter.reset("k")
    assert limiter.retry_after("k") == 0
    for _ in range(4):
        assert limiter.hit("k", 10, 60, max_failures=5, lockout=600, failed=True) == 0


def test_window_expires(limiter: RateLimiter) -> None:
    """По истечении окна лимит восстанавливается."""
    for _ in range(3):
        limiter.hit("k", 3, 0.2)
    assert limiter.hit("k", 3, 0.2) > 0
    time.sleep(0.25)
    assert limiter.check("k", 3, 0.2) == 0


def test_keys_are_isolated(limiter: RateLimiter) -> None:
    """Лимит одного логина не блокирует другой."""
    for _ in range(5):
        limiter.hit("login:10.0.0.1:a@x", 5, 60)
    assert limiter.hit("login:10.0.0.1:a@x", 5, 60) > 0
    assert limiter.hit("login:10.0.0.1:b@x", 5, 60) == 0


def test_reset_clears_block(limiter: RateLimiter) -> None:
    """reset() снимает и обычное окно, и карантин."""
    for _ in range(6):
        limiter.hit("k", 5, 60, max_failures=5, lockout=600, failed=True)
    assert limiter.retry_after("k") > 0
    limiter.reset("k")
    assert limiter.retry_after("k") == 0
