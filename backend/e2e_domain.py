# -*- coding: utf-8 -*-
"""Сквозной тест ForteOn через домен: логин -> токен -> защищённые разделы.

Пароли не хранятся в коде: берутся из окружения
(FORTEON_MANAGER_PASSWORD / FORTEON_ADMIN_PASSWORD).
"""
import json
import os
import socket
import ssl

IP = "37.79.240.231"
HOST = "forteon.pro"

CREDENTIALS = [
    ("manager@forteon.local", os.getenv("FORTEON_MANAGER_PASSWORD", "")),
    ("admin@forteon.local", os.getenv("FORTEON_ADMIN_PASSWORD", "")),
]
CREDENTIALS = [(email, pwd) for email, pwd in CREDENTIALS if pwd]
if not CREDENTIALS:
    raise SystemExit(
        "Задайте FORTEON_MANAGER_PASSWORD и/или FORTEON_ADMIN_PASSWORD в окружении."
    )


def call(method, path, body=None, token=None, host=HOST, ip=IP):
    ctx = ssl.create_default_context()
    raw = socket.create_connection((ip, 443), timeout=40)
    sock = ctx.wrap_socket(raw, server_hostname=host)
    try:
        payload = b""
        headers = [
            "{} {} HTTP/1.1".format(method, path),
            "Host: {}".format(host),
            "User-Agent: forteon-e2e/1.0",
            "Accept: application/json",
            "Connection: close",
        ]
        if token:
            headers.append("Authorization: Bearer {}".format(token))
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers.append("Content-Type: application/json")
            headers.append("Content-Length: {}".format(len(payload)))
        sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("ascii") + payload)

        data = b""
        while True:
            chunk = sock.recv(16384)
            if not chunk:
                break
            data += chunk

        head_raw, _, body_raw = data.partition(b"\r\n\r\n")
        lines = head_raw.decode("latin-1").split("\r\n")
        code = int(lines[0].split(" ")[1])
        hdrs = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                hdrs[k.strip().lower()] = v.strip()
        if hdrs.get("transfer-encoding", "").lower() == "chunked":
            out = b""
            rest = body_raw
            while rest:
                idx = rest.find(b"\r\n")
                if idx < 0:
                    break
                size = int(rest[:idx], 16)
                if size == 0:
                    break
                out += rest[idx + 2: idx + 2 + size]
                rest = rest[idx + 4 + size:]
            body_raw = out
        try:
            parsed = json.loads(body_raw.decode("utf-8"))
        except Exception:
            parsed = None
        return code, hdrs, parsed
    finally:
        sock.close()


print("=" * 76)
print("1. LOGIN")
print("=" * 76)
token = None
manager_token = None
for email, pwd in CREDENTIALS:
    code, hdrs, data = call("POST", "/api/v1/auth/login",
                            {"email": email, "password": pwd})
    ok = code == 200 and isinstance(data, dict) and data.get("access_token")
    print("   {:<26} HTTP {}  token={}  cookie={}".format(
        email, code, "есть" if ok else "НЕТ",
        "есть" if "set-cookie" in hdrs else "нет"))
    if ok:
        if email.startswith("manager"):
            manager_token = data["access_token"]
        else:
            token = data["access_token"]

print("")
print("=" * 76)
print("2. ЗАЩИЩЁННЫЕ РАЗДЕЛЫ (manager)")
print("=" * 76)
checks = [
    ("GET", "/api/v1/auth/me", 200),
    ("GET", "/api/v1/planner", 200),
    ("GET", "/api/v1/planner/summary", 200),
    ("GET", "/api/v1/clients?limit=5", 200),
    ("GET", "/api/v1/tasks?limit=5", 200),
    ("GET", "/api/v1/notifications", 200),
    ("GET", "/api/v1/dashboard", 200),
    ("GET", "/api/v1/admin/users", 403),
]
passed = failed = 0
for method, path, expected in checks:
    code, _, _ = call(method, path, token=manager_token)
    ok = code == expected
    passed += 1 if ok else 0
    failed += 0 if ok else 1
    print("   [{}] {:>4} (ждали {})  {}".format("OK " if ok else "BAD", code, expected, path))

print("")
print("=" * 76)
print("3. АДМИН")
print("=" * 76)
admin_checks = [
    ("GET", "/api/v1/admin/users", 200),
    ("GET", "/api/v1/admin/stats", 200),
    ("GET", "/api/v1/admin/ai-settings", 200),
    ("GET", "/api/v1/admin/audit-log?limit=5", 200),
]
for method, path, expected in admin_checks:
    code, _, data = call(method, path, token=token)
    ok = code == expected
    passed += 1 if ok else 0
    failed += 0 if ok else 1
    extra = ""
    if isinstance(data, dict) and "model" in data:
        extra = "  model={} provider={}".format(data.get("model"), data.get("provider"))
    print("   [{}] {:>4} (ждали {})  {}{}".format(
        "OK " if ok else "BAD", code, expected, path, extra))

print("")
print("=" * 76)
print("4. AI HEALTH (реальный запрос к RouterAI)")
print("=" * 76)
code, _, data = call("GET", "/api/v1/admin/ai-health", token=token)
print("   HTTP {}  ->  {}".format(code, json.dumps(data, ensure_ascii=False)))

print("")
print("=" * 76)
print("ИТОГО: {} прошло, {} не прошло".format(passed, failed))
print("=" * 76)
