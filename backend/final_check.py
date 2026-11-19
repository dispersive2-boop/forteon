# -*- coding: utf-8 -*-
"""Финальная проверка: настоящий DNS-резолв + TLS + все страницы."""
import json
import socket
import ssl
import urllib.request

HOST = "forteon.pro"
WWW = "www.forteon.pro"
GOOD = "37.79.240.231"

PAGES = [
    ("/health", 200),
    ("/api/v1/auth/me", 401),
    ("/api/docs", 200),
    ("/api/openapi.json", 200),
    ("/login", 200),
    ("/today", 200),
    ("/planner", 200),
    ("/clients", 200),
    ("/reports", 200),
    ("/logo.svg", 200),
]


def resolve(host):
    return sorted({ai[4][0] for ai in socket.getaddrinfo(
        host, 443, socket.AF_INET, socket.SOCK_STREAM)})


def fetch(host, path, method="GET"):
    """Обычный запрос — DNS резолвится системой, как это делает браузер."""
    ctx = ssl.create_default_context()
    with socket.create_connection((host, 443), timeout=30) as raw:
        with ctx.wrap_socket(raw, server_hostname=host) as tls:
            req = (
                "{m} {p} HTTP/1.1\r\nHost: {h}\r\nUser-Agent: forteon-final/1.0\r\n"
                "Accept: */*\r\nConnection: close\r\n\r\n"
            ).format(m=method, p=path, h=host)
            tls.sendall(req.encode("ascii"))
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = tls.recv(8192)
                if not chunk:
                    break
                data += chunk
            head = data.split(b"\r\n\r\n", 1)[0].decode("latin-1").split("\r\n")
            code = int(head[0].split(" ")[1])
            cert = tls.getpeercert()
            issuer = dict(x[0] for x in cert["issuer"]).get("organizationName", "?")
            return code, issuer, tls.version()


print("=" * 74)
print("1. DNS (как видит система)")
print("=" * 74)
ok_dns = True
for host in (HOST, WWW):
    try:
        ips = resolve(host)
        good = ips == [GOOD]
        ok_dns = ok_dns and good
        print("  {:<16} -> {}  {}".format(host, ips, "OK" if good else "НЕВЕРНО"))
    except Exception as exc:
        ok_dns = False
        print("  {:<16} -> ошибка {}".format(host, exc))

print()
print("=" * 74)
print("2. TLS и страницы (обычный резолв, без привязки к IP)")
print("=" * 74)
passed = failed = 0
for path, expected in PAGES:
    try:
        code, issuer, ver = fetch(HOST, path)
        ok = code == expected
        passed += 1 if ok else 0
        failed += 0 if ok else 1
        print("  [{}] {:>4} (ждали {})  {:<24} {} {}".format(
            "OK " if ok else "BAD", code, expected, path, ver, issuer))
    except Exception as exc:
        failed += 1
        print("  [ERR]      (ждали {})  {:<24} {}".format(expected, path, type(exc).__name__))

print()
print("=" * 74)
print("3. www и редирект")
print("=" * 74)
try:
    code, issuer, ver = fetch(WWW, "/login")
    print("  www /login -> {}  {}  {}".format(code, ver, issuer))
except Exception as exc:
    print("  www /login -> ошибка {}".format(exc))

print()
print("=" * 74)
print("ИТОГО: страниц {} прошло, {} не прошло".format(passed, failed))
print("DNS: {}".format("корректен" if ok_dns else "ещё не обновился на этом устройстве"))
print("=" * 74)
