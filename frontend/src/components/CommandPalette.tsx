"use client";

/**
 * Горячие клавиши и командная палитра (Ctrl+K).
 *
 * Правила:
 *  - не срабатывать, когда фокус в поле ввода (иначе «n» в заметке
 *    улетит на /notes вместо текста);
 *  - N — новая заметка, / — поиск клиента, Ctrl+K — палитра;
 *  - Esc закрывает палитру (модалки уже умеют).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { api } from "@/lib/api";

type PaletteItem = {
  id: string;
  label: string;
  hint?: string;
  group: "nav" | "record";
  href?: string;
  action?: () => void;
};

type WorkspaceHit = {
  id: string;
  label: string;
  matched_field: string;
  matched_value: string;
  client_name: string;
  href: string;
};

const NAV: { label: string; href: string }[] = [
  { label: "Свободная заметка", href: "/free-note" },
  { label: "Сегодня", href: "/today" },
  { label: "Планировщик", href: "/planner" },
  { label: "Клиенты", href: "/clients" },
  { label: "Заметки", href: "/notes" },
  { label: "Финансы", href: "/finance" },
  { label: "Отчёты", href: "/reports" },
  { label: "Настройки", href: "/settings" },
  { label: "Помощь", href: "/help" },
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    el.isContentEditable === true
  );
}

export function openPalette() {
  window.dispatchEvent(new CustomEvent("forteon:palette"));
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; hits: WorkspaceHit[]; error?: string }>();
  const term = query.trim();
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setQuery("");
      setActive(0);
    };
    window.addEventListener("forteon:palette", onOpen);
    return () => window.removeEventListener("forteon:palette", onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open || term.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const data = await api<{ items: WorkspaceHit[] }>(`/workspace-search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setResults({ query: term, hits: data.items });
      } catch {
        if (!controller.signal.aborted) setResults({ query: term, hits: [], error: "Поиск недоступен. Попробуйте ещё раз." });
      }
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, term]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const result: PaletteItem[] = [];

    for (const n of NAV) {
      if (!q || n.label.toLowerCase().includes(q)) {
        result.push({ id: `nav:${n.href}`, label: n.label, group: "nav", href: n.href });
      }
    }

    if (results?.query === term) {
      for (const hit of results.hits) {
        result.push({
          id: hit.id, label: hit.label, group: "record", href: hit.href,
          hint: [hit.matched_field, hit.matched_value === hit.label ? null : hit.matched_value,
            hit.client_name === hit.label ? null : hit.client_name].filter(Boolean).join(" · "),
        });
      }
    }
    return result;
  }, [term, results]);

  useEffect(() => setActive(0), [query]);

  const go = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      setOpen(false);
      if (item.href) {
        const url = new URL(item.href, window.location.origin);
        if (item.group === "record" && url.pathname === window.location.pathname) {
          window.history.pushState(null, "", item.href);
          window.dispatchEvent(new Event("forteon:record-link"));
        } else {
          router.push(item.href, { scroll: !url.hash });
        }
      }
      item.action?.();
    },
    [router],
  );

  if (!open) return null;

  const groups: { key: PaletteItem["group"]; label: string }[] = [
    { key: "nav", label: "Разделы" },
    { key: "record", label: "Записи CRM" },
  ];

  let index = -1;

  return (
    <div
      className="forteon-overlay fixed inset-0 z-[60] flex items-start justify-center bg-[#0b1220]/55 p-4 pt-[12vh]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Командная палитра"
        className="forteon-floating forteon-popover w-full max-w-xl overflow-hidden bg-surface"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3.5 py-3">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="shrink-0 text-[var(--muted)]"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.6-3.6" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((v) => Math.max(0, Math.min(v + 1, items.length - 1)));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((v) => Math.max(v - 1, 0));
              }
              if (e.key === "Enter") {
                e.preventDefault();
                go(items[active]);
              }
            }}
            placeholder="Имя, телефон, номер договора…"
            aria-label="Поиск по CRM"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-[var(--muted)]"
          />
          <kbd className="shrink-0 rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]">
            Esc
          </kbd>
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-[var(--muted)]">
              {term.length < 2 ? "Введите минимум два символа." : results?.query !== term
                ? "Ищу…" : results.error ?? "Ничего не нашлось."}
            </p>
          ) : (
            groups.map((group) => {
              const groupItems = items.filter((i) => i.group === group.key);
              if (!groupItems.length) return null;
              return (
                <div key={group.key} className="mb-1">
                  <p className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    {group.label}
                  </p>
                  {groupItems.map((item) => {
                    index += 1;
                    const isActive = index === active;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseEnter={() => setActive(items.indexOf(item))}
                        onClick={() => go(item)}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[14px] transition-colors ${
                          isActive
                            ? "bg-[var(--primary-soft)] text-primary"
                            : "text-ink hover:bg-[#f1f4f9]"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.hint && (
                          <span title={item.hint} className="max-w-[47%] truncate text-[11.5px] text-[var(--muted)]">
                            {item.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--border)] px-3.5 py-2 text-[11.5px] text-[var(--muted)]">
          <span>↑↓ — выбор</span>
          <span>Enter — открыть</span>
          <span className="ml-auto">N — заметка · / — клиенты</span>
        </div>
      </div>
    </div>
  );
}

/** Глобальный слушатель клавиш. Монтируется один раз в AppShell. */
export function KeyboardShortcuts() {
  const router = useRouter();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Палитра сама слушает свой input — сюда попадём только вне неё.
      if (event.ctrlKey || event.metaKey) {
        if (event.key.toLowerCase() === "k") {
          event.preventDefault();
          openPalette();
        }
        return;
      }
      if (isTyping(event.target)) return;
      if (event.key === "/") {
        event.preventDefault();
        router.push("/clients");
        return;
      }
      if (event.key.toLowerCase() === "n" && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        router.push("/notes");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return null;
}
