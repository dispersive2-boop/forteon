# -*- coding: utf-8 -*-
"""Почему страница без стилей: проверяем CSS/JS-ассеты через домен и напрямую."""
import re
import socket
import ssl

DOMAIN = "forteon.pro"


def http(host, path, ip=None, port=443, secure=True):
    """host — для заголовка Host/SNI, ip — куда реально подключаться."""
    target = ip or host
    if secure:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        raw = socket.create_connection((target, port), timeout=25)
        sock = ctx.wrap_socket(raw, server_hostname=host)
    else:
        sock = socket.create_connection((target, port), timeout=25)
    try:
        req = (
            "GET {p} HTTP/1.1\r\nHost: {h}\r\nUser-Agent: Mozilla/5.0\r\n"
            "Accept: text/html,text/css,*/*\r\nConnection: close\r\n\r\n"
        ).format(p=path, h=host)
        sock.sendall(req.encode("ascii"))
        data = b""
        while True:
            chunk = sock.recv(16384)
            if not chunk:
                break
            data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        code = int(lines[0].split(" ")[1])
        hdrs = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                hdrs[k.strip().lower()] = v.strip()
        if hdrs.get("transfer-encoding", "").lower() == "chunked":
            out, rest = b"", body
            while rest:
                idx = rest.find(b"\r\n")
                if idx < 0:
                    break
                size = int(rest[:idx], 16)
                if size == 0:
                    break
                out += rest[idx + 2: idx + 2 + size]
                rest = rest[idx + 4 + size:]
            body = out
        return code, hdrs, body
    finally:
        sock.close()


print("=" * 76)
print("1. HTML страницы /login — какие стили он просит")
print("=" * 76)
code, hdrs, body = http(DOMAIN, "/login")
html = body.decode("utf-8", "replace")
print("  статус:", code, " размер:", len(body), "байт")

css_links = re.findall(r'<link[^>]+href="([^"]+\.css[^"]*)"', html)
js_srcs = re.findall(r'<script[^>]+src="([^"]+\.js[^"]*)"', html)
print("  CSS-файлов в HTML:", len(css_links))
for u in css_links:
    print("     ", u)
print("  JS-файлов в HTML:", len(js_srcs))
for u in js_srcs[:3]:
    print("     ", u)

print()
print("=" * 76)
print("2. Пробуем забрать CSS через ДОМЕН (как браузер)")
print("=" * 76)
for u in css_links:
    try:
        c, h, b = http(DOMAIN, u)
        print("  {} -> {}  type={}  {} байт".format(
            u, c, h.get("content-type", "-"), len(b)))
        if c != 200:
            print("     тело:", b[:200])
    except Exception as exc:
        print("  {} -> ОШИБКА {}: {}".format(u, type(exc).__name__, exc))

print()
print("=" * 76)
print("3. Тот же CSS напрямую на 127.0.0.1:8080 (минуя Caddy)")
print("=" * 76)
for u in css_links:
    try:
        c, h, b = http("127.0.0.1", u, ip="127.0.0.1", port=8080, secure=False)
        print("  {} -> {}  type={}  {} байт".format(
            u, c, h.get("content-type", "-"), len(b)))
    except Exception as exc:
        print("  {} -> ОШИБКА {}: {}".format(u, type(exc).__name__, exc))

print()
print("=" * 76)
print("4. Проверка /_next/static/ на проблемные коды")
print("=" * 76)
for path in ("/_next/static/css/app/layout.css", "/_next/static/chunks/webpack.js"):
    for label, host, ip, port, sec in (
        ("домен 443", DOMAIN, None, 443, True),
        ("127.0.0.1:8080", "127.0.0.1", "127.0.0.1", 8080, False),
    ):
        try:
            c, h, b = http(host, path, ip=ip, port=port, secure=sec)
            print("  {:<16} {:<44} -> {} {}".format(
                label, path, c, h.get("content-type", "")))
        except Exception as exc:
            print("  {:<16} {:<44} -> {}".format(label, path, type(exc).__name__))

print("=" * 76)
