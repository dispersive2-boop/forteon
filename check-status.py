# -*- coding: utf-8 -*-
"""Быстрая проверка состояния ForteOn: локальные порты, DNS и сертификат.

Запуск:  python check-status.py
"""
import http.client
import json
import socket
import ssl
import sys
import urllib.request

WEB_PORT = 8080
API_PORT = 8081
DOMAIN = "forteon.pro"
EXPECTED_IP = "37.79.240.231"


def http_status(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        resp.read()
        return resp.status
    except Exception as exc:
        return f"нет ({type(exc).__name__})"
    finally:
        conn.close()


def public_dns(name):
    url = f"https://cloudflare-dns.com/dns-query?name={name}&type=A"
    req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
    return [a.get("data") for a in (data.get("Answer") or []) if a.get("type") == 1]


print("=" * 62)
print(" LOKАЛЬНЫЕ ПОРТЫ FORTEON")
print("=" * 62)
print(f"  Интерфейс : http://127.0.0.1:{WEB_PORT}/login      -> {http_status(WEB_PORT, '/login')}")
print(f"  Сегодня   : http://127.0.0.1:{WEB_PORT}/today      -> {http_status(WEB_PORT, '/today')}")
print(f"  API       : http://127.0.0.1:{API_PORT}/health     -> {http_status(API_PORT, '/health')}")
print(f"  Swagger   : http://127.0.0.1:{API_PORT}/api/docs   -> {http_status(API_PORT, '/api/docs')}")
print("  Порт 3000 — это AI-агент (Open WebUI), не ForteOn")
print()

print("=" * 62)
print(f" ДОМЕН {DOMAIN}")
print("=" * 62)
try:
    ips = public_dns(DOMAIN)
    match = EXPECTED_IP in ips
    print(f"  Публичный DNS : {ips}")
    print(f"  Ожидается     : {EXPECTED_IP}")
    print(f"  Совпадает     : {'ДА' if match else 'НЕТ (ждём обновления TTL)'}")
except Exception as exc:
    print(f"  DNS ошибка: {exc}")
print()

print("=" * 62)
print(" СЕРТИФИКАТ HTTPS")
print("=" * 62)
try:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with socket.create_connection((DOMAIN, 443), timeout=20) as sock:
        with ctx.wrap_socket(sock, server_hostname=DOMAIN) as tls:
            cert = tls.getpeercert()
    if not cert:
        print("  Отдаётся внутренний сертификат Caddy (LE ещё не подхвачен)")
    else:
        issuer = dict(x[0] for x in cert.get("issuer", ()))
        subject = dict(x[0] for x in cert.get("subject", ()))
        print(f"  CN     : {subject.get('commonName')}")
        print(f"  Issuer : {issuer.get('commonName') or issuer.get('organizationName')}")
        print(f"  До     : {cert.get('notAfter')}")
except Exception as exc:
    print(f"  Ошибка: {type(exc).__name__}: {exc}")
print()
print("Если сертификат Let's Encrypt — откройте https://forteon.pro/login")
