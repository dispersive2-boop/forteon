# -*- coding: utf-8 -*-
"""Проверяем, что реально внутри собранного CSS и какие классы есть."""
import re
import socket
import ssl

DOMAIN = "forteon.pro"


def http(host, path, ip=None, port=443, secure=True):
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
        req = "GET {p} HTTP/1.1\r\nHost: {h}\r\nUser-Agent: M\r\nAccept: */*\r\nConnection: close\r\n\r\n".format(
            p=path, h=host)
        sock.sendall(req.encode("ascii"))
        data = b""
        while True:
            c = sock.recv(16384)
            if not c:
                break
            data += c
        head, _, body = data.partition(b"\r\n\r\n")
        hdrs = {}
        for line in head.decode("latin-1").split("\r\n")[1:]:
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
        return hdrs, body
    finally:
        sock.close()


print("=" * 76)
print("СОДЕРЖИМОЕ layout.css")
print("=" * 76)
_, css = http(DOMAIN, "/_next/static/css/app/layout.css")
text = css.decode("utf-8", "replace")
print("Размер:", len(css), "байт")
print()
print("--- ПОЛНЫЙ CSS ---")
print(text)
print("--- КОНЕЦ CSS ---")
print()

print("=" * 76)
print("ПРОВЕРКА КЛЮЧЕВЫХ КЛАССОВ (используются в UI)")
print("=" * 76)
checks = [
    ".mx-auto", ".max-w-", ".space-y-4", ".flex", ".grid", ".rounded-card",
    ".text-ink", ".bg-surface", "--primary", "--sidebar", "--canvas",
    "rounded-control", "text-[var(--muted)]",
]
for c in checks:
    print("  {:<26} {}".format(c, "ЕСТЬ" if c in text else "НЕТ"))

print()
print("=" * 76)
print("HTML: какие классы просит страница")
print("=" * 76)
_, html_raw = http(DOMAIN, "/login")
html = html_raw.decode("utf-8", "replace")
classes = set()
for m in re.finditer(r'class="([^"]+)"', html):
    for cl in m.group(1).split():
        classes.add(cl.strip())
print("Всего уникальных классов в разметке:", len(classes))
sample = sorted(list(classes))[:40]
print("Примеры:", ", ".join(sample))

missing = [c for c in classes if c and not c.startswith(("jsx-", "next-")) and ("." + c.replace("/", r"\/")) not in text]
print()
print("Классов без правила в CSS:", len(missing))
print("Примеры отсутствующих:", ", ".join(sorted(missing)[:25]))
print("=" * 76)
