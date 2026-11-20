"""Общая изоляция тестов от боевой базы.

Зачем этот файл
---------------
pytest импортирует ВСЕ тестовые модули до запуска первого теста. Раньше каждый
модуль сам выставлял ``FORTEON_DATABASE_URL`` на своём уровне: побеждал тот,
что импортирован раньше, а страховка второго модуля («мы не на боевой БД?»)
падала уже на этапе сборки — весь прогон обрывался одним ERROR.

Поэтому окружение задаётся здесь: conftest.py подгружается до тестовых
модулей, значит к моменту ``from app.config import settings`` переменные уже
на месте, и ``app.db.engine`` создаётся один раз на общий тестовый файл.

Один тестовый файл на весь набор — это нормально: каждая фикстура перед работой
делает ``drop_all()`` + ``create_all()``, тесты идут последовательно и друг
другу не мешают. Держать отдельный файл на модуль нельзя: движок создаётся
один раз при импорте ``app.db`` и второй URL уже не увидит.
"""
from __future__ import annotations

import os
import tempfile

_TEST_DB_FILE = os.path.join(tempfile.gettempdir(), "forteon_test_suite.db")

# Явно, а не setdefault: тесты не должны унаследовать боевой секрет или БД
# из .env. app/config.py уважает уже заданные переменные окружения.
os.environ["FORTEON_DATABASE_URL"] = f"sqlite:///{_TEST_DB_FILE}"
os.environ["FORTEON_SECRET_KEY"] = "test-secret-key-for-forteon-test-suite-only"
os.environ.setdefault("FORTEON_DEBUG", "1")
os.environ.setdefault("FORTEON_ENV", "test")

# Остатки прошлых прогонов: WAL-frames способны «оживить» старые строки,
# а битый -shm вообще блокирует checkpoint. Начинаем с чистого листа.
for _suffix in ("", "-wal", "-shm"):
    try:
        os.remove(_TEST_DB_FILE + _suffix)
    except OSError:
        pass


def is_isolated_database(url: str) -> bool:
    """True, если URL ведёт на тестовый файл, а не на боевую базу.

    Проверяем имя файла, а не полный путь: temp-каталог у каждого пользователя
    свой, а имя «forteon_test_suite.db» — наше и ни с чем не совпадёт.
    """
    if not url.startswith("sqlite"):
        return False
    name = url.rsplit("/", 1)[-1]
    return name.startswith("forteon_test")
