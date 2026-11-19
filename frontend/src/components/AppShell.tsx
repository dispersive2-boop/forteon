"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { useAuth, UserBadge } from "@/components/AuthProvider";
import {
  IconAdmin,
  IconClients,
  IconLogout,
  IconNotes,
  IconPlanner,
  IconPlus,
  IconReports,
  IconSearch,
  IconSettings,
  IconToday,
} from "@/components/icons";

/**
 * Навигация. Цвета заданы явно (#fff / rgba-классами из шкалы Tailwind),
 * потому что `text-white/62` не генерируется и текст становится невидимым
 * на тёмной панели.
 */
const NAV_ITEMS = [
  { href: "/today", label: "Сегодня", hint: "Что делать сейчас", Icon: IconToday },
  { href: "/notes", label: "Заметки", hint: "Записать и разобрать", Icon: IconNotes },
  { href: "/planner", label: "Планировщик", hint: "Все сроки", Icon: IconPlanner },
  { href: "/clients", label: "Клиенты", hint: "Карточки и история", Icon: IconClients },
  { href: "/reports", label: "Отчёты", hint: "PDF и XLSX", Icon: IconReports },
  {
    href: "/admin",
    label: "Администрирование",
    hint: "Люди, импорт, аудит",
    Icon: IconAdmin,
    adminOnly: true,
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === "admin");

  return (
    <div className="flex min-h-screen bg-canvas">
      {mobileOpen && (
        <button
          className="fixed inset-0 z-30 bg-[#0b1220]/45 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Закрыть меню"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[276px] flex-col bg-sidebar transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/*
          Логотип = реальный знак из брендбука (logo-mark.svg, векторизован
          из forteon_logo_reference.png, IoU 95.5%).
          Без rounded-«плитки»: в референсе знак стоит свободно на тёмном фоне,
          а скругление обрезало ему кончики лент.
        */}
        <div className="flex h-[84px] shrink-0 items-center border-b border-white/8 px-5">
          <Link
            href="/today"
            className="focus-ring flex items-center gap-2.5 rounded-control"
            aria-label="ForteOn — на главную"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-mark.svg"
              alt=""
              width={44}
              height={44}
              className="h-11 w-11 shrink-0 drop-shadow-[0_2px_8px_rgba(96,165,250,0.35)]"
            />
            <span className="text-[25px] font-semibold leading-none tracking-[-0.035em] text-white">
              Forte<span className="text-[#60A5FA]">On</span>
            </span>
          </Link>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {items.map(({ href, label, hint, Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 rounded-control px-3 py-2.5 transition-colors ${
                  active
                    ? "bg-[var(--sidebar-active)] text-white shadow-soft"
                    : "text-white/72 hover:bg-[var(--sidebar-hover)] hover:text-white"
                }`}
              >
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
                    active ? "bg-white/16 text-white" : "bg-white/6 text-white/72"
                  }`}
                >
                  <Icon size={19} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-medium leading-tight">
                    {label}
                  </span>
                  <span
                    className={`mt-0.5 block truncate text-[12px] leading-tight ${
                      active ? "text-white/85" : "text-white/45"
                    }`}
                  >
                    {hint}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="shrink-0 border-t border-white/8 px-3 py-3">
          <Link
            href="/settings"
            className="mb-2 flex items-center gap-3 rounded-control px-3 py-2.5 text-[15px] font-medium text-white/72 transition-colors hover:bg-[var(--sidebar-hover)] hover:text-white"
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-white/6">
              <IconSettings size={19} />
            </span>
            Настройки
          </Link>

          {user && (
            <div className="flex items-center justify-between gap-2 rounded-control bg-white/6 px-2.5 py-2">
              <UserBadge user={user} />
              <button
                onClick={signOut}
                title="Выйти"
                aria-label="Выйти"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-ring"
              >
                <IconLogout size={18} />
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-[64px] items-center gap-3 border-b border-[var(--border)] bg-surface/95 px-4 backdrop-blur md:px-7">
          <button
            onClick={() => setMobileOpen(true)}
            className="grid h-10 w-10 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[#F1F5F9] focus-ring md:hidden"
            aria-label="Открыть меню"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <MobileBrand />
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/clients"
              className="hidden h-10 items-center gap-2 rounded-control border border-[var(--border-strong)] px-3.5 text-[13.5px] font-medium text-[var(--muted)] transition-colors hover:border-primary hover:text-primary focus-ring sm:flex"
            >
              <IconSearch size={16} />
              Найти клиента
            </Link>
            <Link
              href="/notes"
              className="flex h-10 items-center gap-2 rounded-control bg-primary px-4 text-[13.5px] font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] focus-ring"
            >
              <IconPlus size={17} strokeWidth={2.4} />
              Заметка
            </Link>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 md:px-7 md:py-7">{children}</main>
      </div>
    </div>
  );
}

function MobileBrand() {
  return (
    <Link href="/today" className="flex items-center gap-2 rounded-lg focus-ring md:hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo-mark.svg"
        alt="ForteOn"
        width={30}
        height={30}
        className="h-[30px] w-[30px]"
      />
      <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">
        Forte<span className="text-primary">On</span>
      </span>
    </Link>
  );
}
