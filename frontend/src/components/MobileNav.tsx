"use client";

/**
 * Мобильная нижняя навигация — отдельный интерфейс, не уменьшенный десктоп.
 *
 * DESIGN TASKS v2.1, §8:
 *  91  полностью отдельная компоновка, а не сжатая сетка
 *  92  фиксирована снизу, учитывает safe-area (вырез, домашний индикатор)
 *  93  пять действий: Сегодня, Клиенты, Микрофон, Планы, Ещё
 *  94  микрофон открывает создание голосовой заметки
 *  100 зона нажатия не меньше 44×44 CSS px
 *
 * Показывается только на узких экранах (md:hidden), на десктопе не мешает.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { IconClients, IconMore, IconPlanner, IconToday } from "@/components/icons";

export function MobileNav({ overdue = 0 }: { overdue?: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {moreOpen && (
        <button
          className="fixed inset-0 z-40 bg-[#0b1220]/45 md:hidden"
          onClick={() => setMoreOpen(false)}
          aria-label="Закрыть меню"
        />
      )}

      {moreOpen && (
        <div className="fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-50 mx-3 rounded-t-2xl rounded-b-lg border border-[var(--border)] bg-surface p-2 shadow-lift md:hidden">
          {[
            { href: "/notes", label: "Заметки" },
            { href: "/finance", label: "Финансы" },
            { href: "/reports", label: "Отчёты" },
            { href: "/settings", label: "Настройки" },
            { href: "/help", label: "Помощь" },
          ].map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMoreOpen(false)}
              className="focus-ring flex h-12 items-center rounded-lg px-3 text-[15px] font-medium text-ink hover:bg-[#f1f4f9]"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}

      {/*
        Пункт 92: высота 64px + env(safe-area-inset-bottom) — на iPhone
        панель не перекрывается домашним индикатором.
      */}
      <nav
        aria-label="Мобильная навигация"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch">
          <NavCell href="/today" label="Сегодня" active={isActive("/today")} Icon={IconToday} />

          <NavCell
            href="/clients"
            label="Клиенты"
            active={isActive("/clients")}
            Icon={IconClients}
          />

          {/* Пункт 93-94: центральная кнопка микрофона */}
          <div className="relative flex w-[72px] shrink-0 items-start justify-center">
            <button
              type="button"
              onClick={() => router.push("/notes?voice=1")}
              aria-label="Голосовая заметка"
              title="Голосовая заметка"
              className="focus-ring absolute -top-5 grid h-14 w-14 place-items-center rounded-full bg-primary text-white shadow-[0_10px_24px_-8px_rgba(37,99,235,0.85)] transition-transform active:scale-95"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                <rect x="9" y="2.6" width="6" height="11.2" rx="3" />
                <path d="M5.2 11.2a6.8 6.8 0 0 0 13.6 0M12 18v3.4" />
              </svg>
            </button>
          </div>

          <NavCell
            href="/planner"
            label="Планы"
            active={isActive("/planner")}
            Icon={IconPlanner}
            badge={overdue}
          />

          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-label="Ещё"
            aria-expanded={moreOpen}
            className="focus-ring flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[#64748B] transition-colors hover:text-ink"
          >
            <IconMore size={22} />
            <span className="text-[10.5px] font-medium leading-none">Ещё</span>
          </button>
        </div>
      </nav>
    </>
  );
}

function NavCell({
  href,
  label,
  active,
  Icon,
  badge,
}: {
  href: string;
  label: string;
  active: boolean;
  Icon: (props: { size?: number }) => React.ReactElement;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      // Пункт 100: вся ячейка не ниже 44px по высоте (h-16 = 64px).
      className={`focus-ring relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 transition-colors ${
        active ? "text-primary" : "text-[#64748B] hover:text-ink"
      }`}
    >
      <Icon size={22} />
      <span className="text-[10.5px] font-medium leading-none">{label}</span>
      {badge ? (
        <span className="absolute right-[22%] top-2 grid h-4 min-w-4 place-items-center rounded-full bg-[#EF4444] px-1 text-[10px] font-semibold leading-none text-white">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
