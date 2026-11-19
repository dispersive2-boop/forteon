"""Конфигурация приложения ForteOn (12-factor, переменные окружения)."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Читает .env из корня проекта, не перезаписывая уже заданные переменные."""
    for candidate in (BASE_DIR.parent / ".env", BASE_DIR / ".env"):
        if not candidate.is_file():
            continue
        try:
            for raw in candidate.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
            break
        except OSError:
            continue


_load_dotenv()


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _bool(name: str, default: bool = False) -> bool:
    raw = _env(name, "1" if default else "0").lower()
    return raw in ("1", "true", "yes", "on")


class Settings:
    """Настройки читаются из окружения при старте процесса."""

    def __init__(self) -> None:
        self.app_name = "ForteOn API"
        self.version = "1.0.0"
        self.api_prefix = "/api/v1"
        self.debug = _bool("FORTEON_DEBUG", True)

        # Хранилище. По умолчанию — локальный SQLite, в production — PostgreSQL.
        self.database_url = _env(
            "FORTEON_DATABASE_URL",
            f"sqlite:///{(BASE_DIR / 'data' / 'forteon.db').as_posix()}",
        )
        self.sql_echo = _bool("FORTEON_SQL_ECHO", False)

        # Безопасность.
        self.secret_key = _env("FORTEON_SECRET_KEY", "dev-insecure-secret-change-me")
        self.access_token_ttl_minutes = int(_env("FORTEON_ACCESS_TTL", "60"))
        self.refresh_token_ttl_days = int(_env("FORTEON_REFRESH_TTL_DAYS", "30"))
        self.cookie_name = _env("FORTEON_COOKIE_NAME", "forteon_session")
        self.cookie_secure = _bool("FORTEON_COOKIE_SECURE", False)
        self.cors_origins = [
            o.strip()
            for o in _env("FORTEON_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
            if o.strip()
        ]
        self.rate_limit_per_minute = int(_env("FORTEON_RATE_LIMIT", "240"))

        # Защита от перебора паролей (этап A, P0).
        # Попыток входа с одного IP+логина за окно `login_window` секунд.
        self.login_max_attempts = int(_env("FORTEON_LOGIN_MAX_ATTEMPTS", "5"))
        self.login_window_seconds = int(_env("FORTEON_LOGIN_WINDOW", "300"))
        # После превышения — карантин на `lockout` секунд (даже с верным паролем).
        self.login_lockout_seconds = int(_env("FORTEON_LOGIN_LOCKOUT", "900"))
        # Общий потолок запросов к API на пользователя/сессию.
        self.api_limit_per_minute = int(_env("FORTEON_API_LIMIT_PER_MINUTE", "600"))
        # Писать в лог тела запросов с персональными данными (только для отладки).
        self.log_payloads = _bool("FORTEON_LOG_PAYLOADS", False)

        # AI Extractor. Любой OpenAI-совместимый провайдер:
        # OpenRouter, RouterAI (https://routerai.ru/api/v1) и т.п.
        self.ai_api_key = _env("FORTEON_AI_API_KEY") or _env("OPENROUTER_API_KEY")
        self.ai_base_url = _env(
            "FORTEON_AI_BASE_URL",
            _env("OPENROUTER_BASE_URL", "https://routerai.ru/api/v1"),
        ).rstrip("/")
        self.ai_model = _env("FORTEON_AI_MODEL", "z-ai/glm-5.3-flashx-legal")
        self.ai_timeout_seconds = float(_env("FORTEON_AI_TIMEOUT", "60"))
        self.ai_max_tokens = int(_env("FORTEON_AI_MAX_TOKENS", "2000"))
        self.ai_enabled = _bool("FORTEON_AI_ENABLED", True)
        self.ai_max_retries = int(_env("FORTEON_AI_RETRIES", "2"))
        self.ai_temperature = float(_env("FORTEON_AI_TEMPERATURE", "0.1"))
        # Часть моделей не поддерживает response_format=json_object — тогда шлём без него.
        self.ai_json_mode = _bool("FORTEON_AI_JSON_MODE", True)
        self.ai_referer = _env("FORTEON_AI_REFERER", "https://forteon.pro")

        # Наблюдатель за новыми заметками (опрос раз в N секунд).
        self.note_watcher_enabled = _bool("FORTEON_NOTE_WATCHER", True)
        self.note_watcher_interval = int(_env("FORTEON_NOTE_WATCHER_INTERVAL", "60"))
        self.note_watcher_batch = int(_env("FORTEON_NOTE_WATCHER_BATCH", "10"))

        # Файлы и отчёты.
        self.storage_dir = Path(_env("FORTEON_STORAGE_DIR", str(BASE_DIR / "data" / "storage")))
        self.reports_dir = Path(_env("FORTEON_REPORTS_DIR", str(BASE_DIR / "data" / "reports")))
        self.max_upload_bytes = int(_env("FORTEON_MAX_UPLOAD_MB", "25")) * 1024 * 1024
        self.allowed_mime = {
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "image/png",
            "image/jpeg",
            "image/webp",
        }

        # Прочее.
        self.default_timezone = _env("FORTEON_TIMEZONE", "Asia/Yekaterinburg")
        # Учётные данные демо-пользователей НЕ хранятся в исходниках.
        # Пароль задаётся только через .env; если он не задан — при первом
        # старте генерируется случайный и пишется в data/bootstrap-credentials.txt
        # с правами, ограниченными владельцем (см. services/seed.py).
        self.bootstrap_admin_email = _env("FORTEON_ADMIN_EMAIL", "admin@forteon.local")
        self.bootstrap_admin_password = _env("FORTEON_ADMIN_PASSWORD")
        self.bootstrap_manager_email = _env("FORTEON_MANAGER_EMAIL", "manager@forteon.local")
        self.bootstrap_manager_password = _env("FORTEON_MANAGER_PASSWORD")
        self.demo_seed = _bool("FORTEON_DEMO_SEED", True)
        self.telegram_bot_token = _env("FORTEON_TELEGRAM_BOT_TOKEN")
        self.smtp_host = _env("FORTEON_SMTP_HOST")
        self.smtp_port = int(_env("FORTEON_SMTP_PORT", "587") or 587)
        self.smtp_user = _env("FORTEON_SMTP_USER")
        self.smtp_password = _env("FORTEON_SMTP_PASSWORD")
        self.smtp_from = _env("FORTEON_SMTP_FROM", "noreply@forteon.local")

    def prepare_dirs(self) -> None:
        for path in (self.storage_dir, self.reports_dir, BASE_DIR / "data"):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    settings = Settings()
    settings.prepare_dirs()
    return settings


settings = get_settings()
