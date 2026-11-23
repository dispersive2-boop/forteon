"use client";

/**
 * Колокольчик уведомлений в шапке.
 *
 * Раньше там была только красная точка от просрочек — менеджер не видел,
 * что именно случилось, и шёл в планировщик наугад. Теперь: счётчик
 * непрочитанных, последние события, «прочитать все».
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { api } from "@/lib/api";
import { dateTimeRu } from "@/lib/format";

type NotificationItem = {
  id: string;
  task_id: string | null;
  title: string;
  body: string | null;
  scheduled_at: string;
  read_at: string | null;
};

export function NotificationsBell({ overdue }: { overdue?: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);

  const refreshCount = useCallback(async () => {
    try {
      const data = await api<{ count: number }>("/notifications/unread-count");
      setUnread(data.count);
    } catch {
      /* счётчик не критичен */
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<NotificationItem[]>("/notifications?limit=20");
      setItems(data);
      void refreshCount();
    } catch {
      /* тихо: колокольчик не должен ронять шапку */
    } finally {
      setLoading(false);
    }
  }, [refreshCount]);

  useEffect(() => {
    void refreshCount();
    // Обновляем счётчик, когда пользователь возвращается на вкладку.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshCount();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("forteon:notifications", refreshCount);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("forteon:notifications", refreshCount);
    };
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    void loadList();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, loadList]);

  async function markAll() {
    try {
      await api("/notifications/read-all", { method: "POST" });
      setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
      setUnread(0);
    } catch {
      /* повтор по клику */
    }
  }

  async function markOne(id: string) {
    try {
      await api(`/notifications/${id}/read`, { method: "POST" });
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)),
      );
      setUnread((v) => Math.max(0, v - 1));
    } catch {
      /* не критично */
    }
  }

  const badge = unread > 0 ? unread : overdue && overdue > 0 ? overdue : 0;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `Уведомления: ${unread} непрочитанных` : "Уведомления"}
        aria-expanded={open}
        title="Уведомления"
        className="focus-ring relative grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[#F1F5F9] hover:text-ink"
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
          <path d="M10.3 20a2 2 0 0 0 3.4 0" />
        </svg>
        {badge > 0 && (
          <span className="absolute right-1.5 top-1.5 grid min-w-[18px] place-items-center rounded-full bg-[#EF4444] px-1 text-[10px] font-semibold leading-[18px] text-white">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </button>

      {open && (
        <>
          <button
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-label="Закрыть уведомления"
          />
          <div className="fixed inset-x-3 top-[64px] z-50 sm:absolute sm:inset-x-auto sm:right-0 sm:top-[52px] sm:w-[360px] overflow-hidden rounded-card border border-[var(--border)] bg-surface shadow-lift">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3.5 py-2.5">
              <p className="text-[14px] font-semibold text-ink">Уведомления</p>
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => void markAll()}
                  className="focus-ring rounded-lg px-2 py-1 text-[12px] font-medium text-primary hover:bg-[var(--primary-soft)]"
                >
                  Прочитать все
                </button>
              )}
            </div>

            {Boolean(overdue) && (
              <Link href="/today" onClick={() => setOpen(false)}
                className="block border-b border-[var(--border)] bg-[var(--danger-soft)] px-3.5 py-2.5 text-sm font-medium text-[var(--danger)] hover:underline">
                Просроченные задачи: {overdue}
              </Link>
            )}
            <div className="max-h-[min(360px,55dvh)] overflow-y-auto overscroll-contain">
              {loading && items.length === 0 ? (
                <p className="px-3.5 py-6 text-center text-[13px] text-[var(--muted)]">
                  Загружаю…
                </p>
              ) : items.length === 0 ? (
                <p className="px-3.5 py-6 text-center text-[13px] text-[var(--muted)]">
                  Новых уведомлений нет.
                </p>
              ) : (
                items.map((n) => (
                  <div
                    key={n.id}
                    className={`border-b border-[var(--border)] px-3.5 py-2.5 last:border-0 ${
                      n.read_at ? "" : "bg-[var(--primary-soft)]"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                          n.read_at ? "bg-[#cbd5e1]" : "bg-primary"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] font-medium leading-snug text-ink">{n.title}</p>
                        {n.body && (
                          <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--muted)]">
                            {n.body}
                          </p>
                        )}
                        <p className="mt-1 text-[11.5px] text-[var(--muted)]">
                          {dateTimeRu(n.scheduled_at)}
                        </p>
                      </div>
                      {!n.read_at && (
                        <button
                          type="button"
                          onClick={() => void markOne(n.id)}
                          className="focus-ring shrink-0 rounded px-1.5 py-0.5 text-[11.5px] text-primary hover:underline"
                        >
                          Прочитано
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <Link
              href="/today"
              onClick={() => setOpen(false)}
              className="focus-ring block border-t border-[var(--border)] px-3.5 py-2.5 text-center text-[13px] font-medium text-primary hover:bg-[var(--primary-soft)]"
            >
              Все напоминания на «Сегодня»
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
