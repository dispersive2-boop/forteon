"""Точка входа FastAPI приложения ForteOn."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api import admin, auth, clients, finance, notes, reports, tasks
from .config import settings
from .db import init_db, session_scope
from .models import utcnow

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("forteon")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    log.info("ForteOn: схема БД готова (%s)", settings.database_url.split("://")[0])
    if settings.demo_seed:
        try:
            from .services.seed import seed

            with session_scope() as db:
                summary = seed(db)
            log.info("ForteOn: демо-данные %s", summary)
        except Exception as exc:  # не блокируем запуск
            log.warning("ForteOn: seed пропущен — %s: %s", type(exc).__name__, exc)

    if settings.note_watcher_enabled:
        from .services.watcher import watcher

        watcher.start()
        log.info(
            "ForteOn: watcher заметок активен (интервал %s c, провайдер %s, модель %s)",
            settings.note_watcher_interval, settings.ai_base_url, settings.ai_model,
        )

    yield

    if settings.note_watcher_enabled:
        from .services.watcher import watcher

        watcher.stop()
    log.info("ForteOn: остановка")


app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    description="AI-first CRM сопровождения клиентов: заметки → обязательства → задачи → контроль → отчёты",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def timing_and_errors(request: Request, call_next):
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except IntegrityError as exc:
        log.warning("IntegrityError: %s", exc)
        return JSONResponse(
            status_code=409,
            content={"code": "conflict", "message": "Нарушение уникальности данных", "request_id": request.state.rid},
        )
    response.headers["X-Process-Time"] = f"{(time.perf_counter() - started) * 1000:.1f}ms"
    response.headers["X-Request-Id"] = request.state.rid
    return response


@app.middleware("http")
async def request_id(request: Request, call_next):
    import uuid

    request.state.rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
    return await call_next(request)


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        payload = {"request_id": getattr(request.state, "rid", None), **detail}
    else:
        payload = {
            "code": "http_error",
            "message": str(detail),
            "details": None,
            "request_id": getattr(request.state, "rid", None),
        }
    return JSONResponse(status_code=exc.status_code, content=payload, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "code": "validation_error",
            "message": "Некорректные данные запроса",
            "details": exc.errors(),
            "request_id": getattr(request.state, "rid", None),
        },
    )


for router in (auth.router, clients.router, notes.router, tasks.router,
               finance.router, reports.router, admin.router):
    app.include_router(router, prefix=settings.api_prefix)


@app.get("/health", tags=["system"])
def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.version,
        "time": utcnow().isoformat(),
        "ai": {
            "provider": settings.ai_base_url,
            "model": settings.ai_model,
            "api_key": bool(settings.ai_api_key),
            "enabled": settings.ai_enabled,
            "watcher": settings.note_watcher_enabled,
            "watcher_interval": settings.note_watcher_interval,
        },
    }


@app.get("/", include_in_schema=False)
def root():
    return {
        "service": "ForteOn API",
        "docs": "/api/docs",
        "health": "/health",
        "api": settings.api_prefix,
    }
