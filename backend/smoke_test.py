# -*- coding: utf-8 -*-
"""Smoke-тест ForteOn API: авторизация, клиенты, заметка -> AI-задачи, финансы, отчёты.

Учётные данные берутся из .env (FORTEON_ADMIN_PASSWORD / FORTEON_MANAGER_PASSWORD)
либо из bootstrap-credentials.txt, созданного при первом старте.
Паролей в исходниках нет.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BACKEND_DIR))

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app

FAILED: list[str] = []


def _password(env_key: str, email: str) -> str:
    """Пароль: сначала из окружения, затем из bootstrap-credentials.txt."""
    value = os.getenv(env_key, "").strip()
    if value:
        return value
    store = Path(settings.storage_dir).parent / "bootstrap-credentials.txt"
    if store.is_file():
        for line in store.read_text(encoding="utf-8").splitlines():
            parts = line.split("\t")
            if len(parts) == 2 and parts[0].strip() == email:
                return parts[1].strip()
    raise SystemExit(
        f"Не найден пароль для {email}: задайте {env_key} в .env "
        f"или проверьте {store}"
    )


MANAGER = (settings.bootstrap_manager_email,
           _password("FORTEON_MANAGER_PASSWORD", settings.bootstrap_manager_email))
ADMIN = (settings.bootstrap_admin_email,
         _password("FORTEON_ADMIN_PASSWORD", settings.bootstrap_admin_email))


def check(name: str, condition: bool, extra: str = "") -> None:
    status = "OK " if condition else "FAIL"
    print(f"[{status}] {name} {extra}")
    if not condition:
        FAILED.append(name)


with TestClient(app) as client:
    health = client.get("/health")
    check("health", health.status_code == 200, str(health.json().get("version")))

    login = client.post("/api/v1/auth/login",
                        json={"email": MANAGER[0], "password": MANAGER[1]})
    check("login manager", login.status_code == 200)
    if login.status_code != 200:
        print(login.text[:800])
        sys.exit(1)
    token = login.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    me = client.get("/api/v1/auth/me", headers=headers)
    check("auth/me", me.status_code == 200, me.json().get("role", ""))

    clients = client.get("/api/v1/clients?limit=200", headers=headers)
    check("clients list", clients.status_code == 200)
    data = clients.json()
    print(f"      клиентов: {data['total']}, получено: {len(data['items'])}")
    check("clients imported", data["total"] > 20, f"total={data['total']}")

    if data["items"]:
        client_id = data["items"][0]["id"]
        detail = client.get(f"/api/v1/clients/{client_id}", headers=headers)
        check("client detail", detail.status_code == 200)
        projects = client.get(f"/api/v1/clients/{client_id}/projects", headers=headers)
        check("client projects", projects.status_code == 200, f"n={len(projects.json())}")

        note = client.post(
            f"/api/v1/clients/{client_id}/notes",
            headers=headers,
            json={
                "body": "Созвонился с клиентом. Нужно отправить КП завтра. "
                        "Клиент обещал оплатить счёт до 25.11.2026. "
                        "Проблема: нет ответа от подрядчика, срок 30.11.2026.",
                "run_ai": True,
                "idempotency_key": "smoke-note-1",
            },
        )
        check("note create", note.status_code == 201, note.json().get("ai_status", ""))
        note_id = note.json()["id"]

        ai_state = client.get(f"/api/v1/notes/{note_id}/ai-status", headers=headers)
        check("ai-status", ai_state.status_code == 200, str(ai_state.json().get("ai_status")))

        client.post(f"/api/v1/notes/{note_id}/reprocess", headers=headers)
        tasks = client.get(f"/api/v1/notes/{note_id}/tasks", headers=headers)
        check("ai tasks created", tasks.status_code == 200 and len(tasks.json()) > 0,
              f"n={len(tasks.json()) if tasks.status_code == 200 else 'err'}")
        if tasks.status_code == 200 and tasks.json():
            print("      задачи:", [t["title"][:60] for t in tasks.json()[:4]])

        planner = client.get("/api/v1/planner", headers=headers)
        check("planner", planner.status_code == 200)
        summary = client.get("/api/v1/planner/summary", headers=headers)
        check("planner summary", summary.status_code == 200, str(summary.json()))

        fin = client.get(f"/api/v1/clients/{client_id}/financial-summary", headers=headers)
        check("finance summary", fin.status_code == 200, str(fin.json().get("debt")))

        invoices = client.get(f"/api/v1/clients/{client_id}/invoices", headers=headers)
        check("invoices", invoices.status_code == 200, f"n={len(invoices.json())}")

    report = client.post("/api/v1/reports", headers=headers,
                         json={"format": "xlsx", "scope": "all"})
    check("report xlsx", report.status_code == 201 and report.json()["status"] == "ready",
          report.json().get("status", report.text[:200]))
    if report.status_code == 201 and report.json()["status"] == "ready":
        download = client.get(f"/api/v1/reports/{report.json()['id']}/download", headers=headers)
        check("xlsx download", download.status_code == 200, f"{len(download.content)} bytes")

    report_pdf = client.post("/api/v1/reports", headers=headers,
                             json={"format": "pdf", "scope": "all"})
    check("report pdf", report_pdf.status_code == 201 and report_pdf.json()["status"] == "ready",
          report_pdf.json().get("error") or "ok")
    if report_pdf.status_code == 201 and report_pdf.json()["status"] == "ready":
        download = client.get(f"/api/v1/reports/{report_pdf.json()['id']}/download", headers=headers)
        check("pdf download", download.status_code == 200, f"{len(download.content)} bytes")

    dashboard = client.get("/api/v1/dashboard", headers=headers)
    check("dashboard", dashboard.status_code == 200)

    admin_login = client.post("/api/v1/auth/login",
                              json={"email": ADMIN[0], "password": ADMIN[1]})
    check("login admin", admin_login.status_code == 200)
    admin_headers = {"Authorization": f"Bearer {admin_login.json()['access_token']}"}

    forbidden = client.get("/api/v1/admin/users", headers=headers)
    check("admin protected", forbidden.status_code == 403)

    users = client.get("/api/v1/admin/users", headers=admin_headers)
    check("admin users", users.status_code == 200, f"n={len(users.json())}")

    stats = client.get("/api/v1/admin/stats", headers=admin_headers)
    check("admin stats", stats.status_code == 200, str(stats.json()))

    audit = client.get("/api/v1/admin/audit-log?limit=10", headers=admin_headers)
    check("audit log", audit.status_code == 200, f"n={len(audit.json())}")

    bootstrap = client.get("/api/v1/sync/bootstrap", headers=headers)
    check("sync bootstrap", bootstrap.status_code == 200,
          f"clients={len(bootstrap.json().get('clients', []))}")

    push = client.post("/api/v1/sync/push", headers=headers, json={"operations": [{
        "operation_id": "smoke-op-1", "entity": "task", "action": "create",
        "payload": {"client_id": data["items"][0]["id"] if data["items"] else None,
                    "title": "Синхронизированная задача", "priority": "high"},
    }]})
    check("sync push", push.status_code == 200, str(push.json()["results"][0]["status"]))

    pull = client.get("/api/v1/sync/pull?since=0", headers=headers)
    check("sync pull", pull.status_code == 200, f"until={pull.json()['until']}")

print()
if FAILED:
    print("ПРОВАЛЕНО:", ", ".join(FAILED))
    sys.exit(1)
print("ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ")
