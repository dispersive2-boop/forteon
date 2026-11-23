# ForteOn — MVP v1.0

AI-first CRM сопровождения действующих клиентов: **заметки → обязательства → задачи → контроль результата → отчёты**.

Реализация по документации [`ForteOn_Полная_документация_MVP_v1.0.pdf`](../ForteOn_%D0%9F%D0%BE%D0%BB%D0%BD%D0%B0%D1%8F_%D0%B4%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D0%B0%D1%86%D0%B8%D1%8F_MVP_v1.0.pdf) и с использованием данных отчёта [`Отчетная таблица Гришанов к совещанию 16.11.2026.xlsx`](../../Отчетная%20таблица%20Гришанов%20к%20совещанию%2016.11.2026.xlsx).

**Домен:** `https://forteon.pro` · **Порты:** web `8080`, api `8081` · **AI:** RouterAI (`z-ai/glm-5.3-flashx-legal`)

---

## Порты (важно)

| Порт | Что | Наружу |
|---|---|---|
| **8080** | ForteOn frontend (Next.js) | только через Caddy |
| **8081** | ForteOn backend (FastAPI) | только через Caddy (`/api/*`, `/health`) |
| 80 / 443 | Caddy — TLS + reverse proxy | да |
| **3000** | **AI-агент (Open WebUI / rin-ai.pro)** — не трогаем | через Caddy |
| 8000 | Было занято тестовым прогоном | освобождено |

ForteOn и AI-агент разделены: разные хосты (`forteon.pro` / `rin-ai.pro`) и разные внутренние порты.
Подробнее — [`deploy/PORTS.md`](deploy/PORTS.md), конфиг Caddy — [`deploy/Caddyfile.forteon.pro`](deploy/Caddyfile.forteon.pro).

Для production порт 80/443 занят Caddy, поэтому ForteOn наружу публикует только Caddy, а 8080/8081 слушают `127.0.0.1`.

---

## Что уже работает

### Backend (FastAPI + SQLAlchemy)

| Блок | Реализация |
|---|---|
| Модель данных (раздел 06) | 20 таблиц: `users`, `sessions`, `clients`, `client_contacts`, `projects`, `project_modules`, `contracts`, `notes`, `ai_runs`, `tasks`, `commitments`, `invoices`, `payments`, `payment_allocations`, `documents`, `notifications`, `client_transfers`, `sync_operations`, `change_log`, `audit_log`, `report_jobs` |
| Безопасность | Argon2id (fallback scrypt), подписанные токены, refresh-сессии на устройствах, отзыв сессий, HttpOnly-кука, проверка `owner_id` на каждом дочернем объекте, RBAC `manager`/`admin`, журнал аудита |
| API v1 (раздел 11) | `auth`, `clients`, `projects`, `contracts`, `notes`, `voice`, `tasks`, `planner`, `finance`, `documents`, `reports`, `notifications`, `sync`, `admin` — 60+ маршрутов |
| AI Extractor (раздел 07) | **RouterAI** `https://routerai.ru/api/v1`, модель `z-ai/glm-5.3-flashx-legal` (`response_format=json_object`, таймаут 60 с, retry с backoff, авто-отключение json-mode если провайдер не поддерживает) + детерминированный локальный экстрактор как fallback. Валидация типов, дедупликация по `dedupe_key`, `idempotency_key`, связь с заметкой и цитатой, статусы `pending/queued/ok/failed`, устойчивый парсер обрезанного JSON |
| Watcher заметок | Фоновый поток раз в **60 с** подхватывает заметки `pending`/`failed` и прогоняет AI (до 3 попыток, без дублей). Ручной запуск в админке — «Разобрать заметки» |
| Обработка дат (раздел 02) | Явные (`25.11.2026`, «20 ноября»), относительные («завтра», «в пятницу», «через 3 дня», «до конца месяца») от времени заметки в часовом поясе менеджера; при неоднозначности — `due_at=null` и «Уточнить», вымышленный дедлайн не создаётся |
| Обязательства | Отдельная сущность `commitments`: контрагент, обещание, срок, статус, связанная задача |
| Финансы (раздел 10) | Счёт ≠ поступление, `payment_allocations`, долг = выставлено − распределено, ручной ввод, аудит изменений |
| Импорт отчёта Гришанова | 206 клиентов, 206 проектов, 136 задач следующего спринта + 11 проблем → идемпотентно, с построением истории и группировкой по секциям |
| Отчёты | PDF (сводный, по клиенту, с KPI и таблицами) и XLSX (листы «Клиенты», «Проекты», «Задачи», «Финансы», «Проблемы», «Сведения») |
| Offline-first (раздел 08) | `POST /sync/push` c идемпотентностью, `GET /sync/pull` с монотонным курсором `change_log`, `GET /sync/bootstrap` |

### Frontend (Next.js 15 + TypeScript + Tailwind)

Экраны: `/login`, `/today`, `/planner`, `/clients`, `/clients/:id`, `/reports`, `/settings`, `/admin`.

- Дизайн-токены из раздела 03 в [`globals.css`](frontend/src/app/globals.css) (`--sidebar #151B29`, `--primary #2455DB`, `--canvas #F7F9FC`, `--danger #C63B45`, `--success #25865A`, радиус 8–14 px).
- Реконструированный логотип [`logo.svg`](frontend/public/logo.svg) (оригинального векторного исходника нет — это указано в документации).
- Адаптивная композиция: тёмный sidebar + контент на десктопе, мобильное меню и крупные touch-цели, без трёх колонок и горизонтального скролла.
- Действия «Добавить заметку» / «Записать голосом» всегда доступны в карточке клиента.
- PWA-манифест, offline-кэш shell через Next.js.

---

## Быстрый старт (Windows, локально)

### Одной командой

```bat
сц\forteon\start-dev.bat
```

Запускает backend на `:8081` и frontend на `:8080`, открывает браузер.

### 1. Backend вручную

```bat
cd сц\forteon\backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8081
```

`.env` читается из корня проекта `сц\forteon\.env` (секреты только там, файл в `.gitignore`).

При первом старте создаются демо-пользователи и выполняется импорт отчёта Гришанова с рабочего стола (если файла нет — минимальный демо-набор).

- API: <http://127.0.0.1:8081>
- Swagger: <http://127.0.0.1:8081/api/docs>
- Health: <http://127.0.0.1:8081/health>

Bootstrap-учётки:

| Роль | E-mail |
|---|---|
| Менеджер | `manager@forteon.local` |
| Администратор | `admin@forteon.local` |

Пароли не хранятся в репозитории. Если `FORTEON_ADMIN_PASSWORD` и
`FORTEON_MANAGER_PASSWORD` не заданы в `.env`, при первом старте генерируются
случайные и записываются в `backend/data/bootstrap-credentials.txt`
(файл в `.gitignore`). Смените пароли через интерфейс администратора.

### 2. Frontend вручную

```bat
cd сц\forteon\frontend
npm install
set NEXT_PUBLIC_API_URL=http://127.0.0.1:8081
npm run dev -- -p 8080
```

Интерфейс: <http://127.0.0.1:8080>

### 3. Smoke-тест backend

```bat
cd сц\forteon\backend
python smoke_test.py
```

Проверяет вход, карточку клиента, заметку → AI-задачи, планировщик, финансы, отчёты PDF/XLSX, RBAC, аудит и синхронизацию.

---

## Production: forteon.pro через Caddy

1. Скопировать блок из [`deploy/Caddyfile.forteon.pro`](deploy/Caddyfile.forteon.pro) в `C:\home_agent\caddy\Caddyfile` (после глобального блока `{...}`).
2. Проверить: `C:\home_agent\caddy\caddy.exe validate --config C:\home_agent\caddy\Caddyfile --adapter caddyfile`
3. Перезапустить службу Caddy: `Restart-Service Caddy`
4. A-запись `forteon.pro` и `www.forteon.pro` → IP этой машины; Caddy сам выпустит сертификат Let's Encrypt.
5. В `.env`: `FORTEON_COOKIE_SECURE=true`, `FORTEON_CORS_ORIGINS=https://forteon.pro,https://www.forteon.pro`.

Схема трафика:

```
https://forteon.pro/       → 127.0.0.1:8080  (Next.js)
https://forteon.pro/api/*  → 127.0.0.1:8081  (FastAPI)
https://forteon.pro/health → 127.0.0.1:8081/health
https://rin-ai.pro/        → 127.0.0.1:3000  (AI-агент, не затронут)
```

### Docker Compose (альтернатива)

```bat
cd сц\forteon
copy .env.example .env
docker compose up -d --build
```

Контейнеры: `postgres`, `redis`, `api`, `worker` (Celery), `web`. Порты публикуются только на `127.0.0.1` (8080/8081) — Caddy остаётся единственной точкой входа.

Перед production обязательно:
1. Задать `FORTEON_SECRET_KEY` (длинная случайная строка) и `POSTGRES_PASSWORD`.
2. Сменить демо-пароли и `FORTEON_DEMO_SEED=false`.
3. Включить `FORTEON_COOKIE_SECURE=true` и HTTPS reverse proxy.
4. Указать `OPENROUTER_API_KEY` и выбранную модель.
5. Настроить резервное копирование БД/файлов и тест восстановления.

---

## Структура проекта

```
сц/forteon/
├── backend/
│   ├── app/
│   │   ├── api/            # auth, clients, notes, tasks, finance, reports, admin
│   │   ├── services/       # ai, extraction, dates, importer, reports, seed
│   │   ├── config.py       # настройки из окружения
│   │   ├── db.py           # engine, session, init_db
│   │   ├── models.py       # 20 моделей по разделу 06
│   │   ├── schemas.py      # Pydantic-схемы API
│   │   ├── security.py     # Argon2id/scrypt, токены
│   │   ├── deps.py         # current_user, owner-check, аудит
│   │   ├── main.py         # приложение, обработчики ошибок
│   │   └── worker.py       # Celery-задачи
│   ├── requirements.txt
│   ├── Dockerfile
│   └── smoke_test.py
├── frontend/
│   ├── src/app/            # маршруты (app-router)
│   ├── src/components/     # AppShell, AuthProvider, UI-примитивы
│   ├── src/lib/            # api-клиент, форматтеры
│   ├── public/logo.svg
│   ├── Dockerfile
│   └── package.json
├── docker-compose.yml
└── .env.example
```

---

## Соответствие приёмочным тестам (раздел 13)

| Критерий | Статус |
|---|---|
| Менеджер не получает чужого клиента ни по списку, ни по UUID | ✅ 404 на чужого клиента в [`deps.py`](backend/app/deps.py) |
| Две сессии синхронизируются без потерь | ✅ `/sync/push` идемпотентен по `operation_id`, `/sync/pull` по курсору |
| Конфликт финансов не перезаписывается молча | ✅ `409 version_conflict` + аудит изменений счёта |
| Повторная отправка заметки/AI/sync не создаёт дублей | ✅ `idempotency_key`, `dedupe_key` |
| Явные/относительные даты, отрицания, условные обещания | ✅ [`dates.py`](backend/app/services/dates.py), `conditional`, `needs_review` |
| Без интернета заметка сохраняется локально | ✅ PWA shell + IndexedDB-контракт (клиентская часть) |
| PDF/XLSX отражают фильтры и суммы; по клиенту — без чужих данных | ✅ генерация в [`reports.py`](backend/app/services/reports.py) |
| Уведомления не дублируются | ✅ модель `notifications`, группировка и quiet hours в настройках |
| Восстановление из бэкапа и загрузка документов | ✅ документы с MIME/размер/checksum; бэкап — регламент эксплуатации |

---

## Открытые параметры (требуют решения заказчика)

- Конкретная модель OpenRouter и STT-провайдер, стоимость, условия обработки данных.
- Характеристики выделенного сервера, домен и почта.
- Часовые пояса, рабочие часы, политики уведомлений и сроки хранения.
- Максимальный размер файла и квоты на клиента.
- Точность AI на реальных заметках (цель 95% для явных задач — ориентир, не подтверждённая точность).

## Почта Zimbra и Форти

В конфигурации backend укажите разрешённый HTTPS-сервер в `FORTEON_ZIMBRA_ORIGINS`.
Для нескольких серверов перечислите их через запятую.
Сгенерируйте отдельный ключ шифрования для `FORTEON_MAIL_SECRET`:

```text
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Храните ключ в настройках сервера и используйте его при каждом перезапуске.
После обновления зависимостей и перезапуска backend откройте «Настройки → Почта Zimbra».
Адрес, логин и пароль сохраняются отдельно для каждого пользователя ForteOn.
В разделе «Форти и почта» можно продиктовать поручение, выбрать получателя и вложения
и отправить проверенный черновик. Файлы с устройства и документы ForteOn можно
прикладывать к одному письму.
