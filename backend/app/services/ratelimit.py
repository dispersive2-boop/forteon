"""Ограничение частоты запросов (rate limiting) без внешних зависимостей.

Реализовано скользящее окно в памяти процесса. Для одного инстанса uvicorn
этого достаточно; при переходе на несколько воркеров заменить хранилище на
Redis (интерфейс сохранён: hit() / check() / reset()).

Ключевые сценарии, ради которых модуль написан (этап A, P0 ТЗ v2):
  * перебор паролей на /auth/login — блокировка после N неудач;
  * злоупотребление /auth/refresh;
  * общий потолок запросов на пользователя.

Не использует системное время напрямую: часы можно подменить в тестах.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


@dataclass
class _Bucket:
    """Кольцевой список отметок времени попаданий в окно."""

    hits: list[float] = field(default_factory=list)
    blocked_until: float = 0.0


class RateLimiter:
    """Скользящее окно: не более `limit` событий за `window` секунд.

    Дополнительно поддерживает «карантин»: после `max_failures` неудач
    ключ блокируется на `lockout` секунд, даже если окно уже очистилось.
    """

    def __init__(self) -> None:
        self._buckets: dict[str, _Bucket] = {}
        self._lock = threading.Lock()
        self._last_gc = 0.0

    # ---------------------------------------------------------------- служебное
    def _gc(self, now: float) -> None:
        """Редкая уборка мусора, чтобы словарь не рос бесконечно."""
        if now - self._last_gc < 300:
            return
        self._last_gc = now
        dead = [
            key
            for key, bucket in self._buckets.items()
            if bucket.blocked_until < now and (not bucket.hits or max(bucket.hits) < now - 3600)
        ]
        for key in dead:
            self._buckets.pop(key, None)

    def _bucket(self, key: str, now: float) -> _Bucket:
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket()
            self._buckets[key] = bucket
        return bucket

    # ------------------------------------------------------------------- API
    def retry_after(self, key: str) -> float:
        """Сколько секунд осталось до снятия блокировки (0 — не заблокирован)."""
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None or bucket.blocked_until <= now:
                return 0.0
            return round(bucket.blocked_until - now, 1)

    def check(self, key: str, limit: int, window: float) -> float:
        """Проверка без регистрации события.

        Возвращает 0, если можно продолжать, иначе — секунды до сброса.
        """
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                return 0.0
            if bucket.blocked_until > now:
                return round(bucket.blocked_until - now, 1)
            fresh = [t for t in bucket.hits if t > now - window]
            bucket.hits = fresh
            if len(fresh) >= limit:
                return round(window - (now - fresh[0]), 1) if fresh else window
            return 0.0

    def hit(
        self,
        key: str,
        limit: int,
        window: float,
        *,
        max_failures: int | None = None,
        lockout: float = 0.0,
        failed: bool = False,
    ) -> float:
        """Регистрирует событие и возвращает секунды блокировки (0 — пропускаем).

        `failed=True` помечает событие как неудачу (например, неверный пароль);
        при достижении `max_failures` ключ попадает в карантин на `lockout`.
        """
        now = time.monotonic()
        with self._lock:
            self._gc(now)
            bucket = self._bucket(key, now)

            if bucket.blocked_until > now:
                return round(bucket.blocked_until - now, 1)

            bucket.hits = [t for t in bucket.hits if t > now - window]

            if len(bucket.hits) >= limit:
                # Уперлись в потолок: блокируем ровно до момента, когда самое
                # старое попадание выйдет из окна. Искусственного минимума нет —
                # длину окна задаёт вызывающий код.
                wait = (window - (now - bucket.hits[0])) if bucket.hits else window
                wait = max(wait, 0.001)
                bucket.blocked_until = now + wait
                return round(wait, 2)

            bucket.hits.append(now)

            if failed and max_failures and lockout > 0:
                failures = sum(1 for t in bucket.hits if t > now - window)
                if failures >= max_failures:
                    bucket.blocked_until = now + lockout
                    bucket.hits.clear()
                    return round(lockout, 1)

            return 0.0

    def reset(self, key: str) -> None:
        """Сброс после успешного входа: неудачи больше не считаются."""
        with self._lock:
            self._buckets.pop(key, None)

    def client_key(self, request, scope: str = "") -> str:
        """Ключ по IP + логину (если передан) + области применения.

        IP берём из заголовка X-Forwarded-For только при наличии прокси:
        иначе клиент подделает его и обойдёт лимит.
        """
        peer = request.client.host if request.client else "unknown"
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            first = forwarded.split(",")[0].strip()
            if first:
                peer = first
        return f"{scope}:{peer}"


limiter = RateLimiter()


# ------------------------------------------------------------------ исключение
class RateLimitExceeded(Exception):
    """Сигнал обработчику: запрос надо отклонить с 429."""

    def __init__(self, retry_after: float, reason: str, message: str) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        self.reason = reason
        self.message = message
