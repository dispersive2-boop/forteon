"use client";

/**
 * Каркас приложения: сайдбар + верхняя панель + область контента.
 *
 * DESIGN TASKS v2.1:
 *  §1 (п.1-3, 8, 10): сайдбар фиксирован 232-248px и #111827;
 *      топбар 64-72px с названием страницы, поиском, уведомлениями,
 *      профилем и кнопкой «Новая заметка»; горизонтальной прокрутки нет;
 *      на узком экране панель — выдвижной drawer.
 *  §2 (п.11-18): строгий порядок пунктов, БЕЗ подписей-подсказок,
 *      активный пункт — синяя подложка, иконки 20px с единой толщиной,
 *      счётчик просрочек у «Планировщик» только при наличии,
 *      внизу аватар + имя + выход, «Администрирование» только админу,
 *      «Проекты» отдельным пунктом не выводим.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAuth, UserBadge } from "@/components/AuthProvider";
import {
  IconAdmin,
  IconClients,
  IconFinance,
  IconHelp,
  IconLogout,
  IconNotes,
  IconPlanner,
  IconPlus,
  IconReports,
  IconSearch,
  IconSettings,
  IconToday,
} from "@/components/icons";
import { MobileNav } from "@/components/MobileNav";
import { api, TodayPayload } from "@/lib/api";

/**
 * Строгий порядок из макета (§2). Подписи-подсказки удалены (п.11):
 * они дублировали название и мешали быстрому сканированию.
 */
const NAV_ITEMS = [
  { href: "/today", label: "Сегодня", Icon: IconToday },
  { href: "/planner", label: "Планировщик", Icon: IconPlanner, badge: "overdue" as const },
  { href: "/clients", label: "Клиенты", Icon: IconClients },
  { href: "/notes", label: "Заметки", Icon: IconNotes },
  { href: "/finance", label: "Финансы", Icon: IconFinance },
  { href: "/reports", label: "Отчёты", Icon: IconReports },
  { href: "/settings", label: "Настройки", Icon: IconSettings },
  { href: "/help", label: "Помощь", Icon: IconHelp },
  { href: "/admin", label: "Администрирование", Icon: IconAdmin, adminOnly: true },
];

const PAGE_TITLES: Record<string, string> = {
  "/today": "Сегодня",
  "/planner": "Планировщик",
  "/clients": "Клиенты",
  "/notes": "Заметки",
  "/finance": "Финансы",
  "/reports": "Отчёты",
  "/settings": "Настройки",
  "/help": "Помощь",
  "/admin": "Администрирование",
};

function pageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  const base = `/${pathname.split("/")[1] ?? ""}`;
  if (PAGE_TITLES[base]) return PAGE_TITLES[base];
  if (pathname.startsWith("/clients/")) return "Карточка клиента";
  return "ForteOn";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [overdue, setOverdue] = useState(0);
  /**
   * П.128: статус сети виден интерфейсу. navigator.onLine не идеален, но
   * даёт честный сигнал при обрыве; запросы всё равно упадут с ошибкой,
   * а менеджер увидит причину, а не «что-то пошло не так».
   */
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  /*
    Пункт 6: выдвижное меню закрывается по Esc. Раньше на телефоне
    единственным способом был тап по затемнению — с клавиатуры (планшет,
    внешняя клавиатура) меню не закрывалось вообще.
  */
  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === "admin");

  /** Пункт 14: счётчик просрочек у «Планировщик», обновляется без перезагрузки. */
  const refreshOverdue = useCallback(async () => {
    try {
      const data = await api<TodayPayload>("/tasks/today");
      setOverdue(data.counters.overdue);
    } catch {
      /* счётчик не критичен — молча пропускаем */
    }
  }, []);

  useEffect(() => {
    void refreshOverdue();
  }, [refreshOverdue, pathname]);

  return (
    <div className="flex min-h-screen w-full max-w-full overflow-x-hidden bg-canvas">
      {mobileOpen && (
        <button
          className="fixed inset-0 z-30 bg-[#0b1220]/45 md:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Закрыть меню"
        />
      )}

      {/* Пункт 1: ширина 232-248px, цвет #111827; пункт 17 — скроллится только навигация */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[240px] flex-col bg-[#111827] transition-transform duration-200 md:sticky md:top-0 md:h-screen md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/*
          Логотип = реальный знак из брендбука (logo-mark.svg, векторизован
          из forteon_logo_reference.png, IoU 95.5%).
          Без rounded-«плитки»: в референсе знак стоит свободно на тёмном фоне,
          а скругление обрезало ему кончики лент.
        */}
        <div className="flex h-[68px] shrink-0 items-center px-4">
          <Link
            href="/today"
                className="focus-ring flex min-h-[44px] items-center gap-2.5 rounded-lg"
            aria-label="ForteOn — на главную"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-mark.svg"
              alt=""
              width={38}
              height={38}
              className="h-[38px] w-[38px] shrink-0 drop-shadow-[0_2px_8px_rgba(96,165,250,0.35)]"
            />
            <span className="text-[22px] font-semibold leading-none tracking-[-0.035em] text-white">
              Forte<span className="text-[#60A5FA]">On</span>
            </span>
          </Link>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-2" aria-label="Основная навигация">
          {items.map(({ href, label, Icon, badge }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            const showBadge = badge === "overdue" && overdue > 0;
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`focus-ring flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium transition-colors ${
                  active
                    ? "bg-[#2563EB] text-white"
                    : "text-[#CBD5E1] hover:bg-white/8 hover:text-white"
                }`}
              >
                {/* Пункт 13: иконки 20px, единая толщина штриха */}
                <span className="grid h-6 w-6 shrink-0 place-items-center">
                  <Icon size={20} />
                </span>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {showBadge && (
                  <span className="shrink-0 rounded-full bg-[#EF4444] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
                    {overdue}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Пункт 15: аватар, имя и выход внизу */}
        <div className="shrink-0 border-t border-white/10 px-2.5 py-3">
          {user && (
            <div className="flex items-center gap-2 rounded-lg px-1 py-1">
              <UserBadge user={user} />
              <button
                onClick={signOut}
                title="Выйти из аккаунта"
                aria-label="Выйти из аккаунта"
                className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[#6B7280] transition-colors hover:bg-white/10 hover:text-white"
              >
                <IconLogout size={18} />
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 max-w-full flex-1 flex-col">
        {/* Пункт 3: топбар 64-72px — название страницы, поиск, уведомления, профиль, «Новая заметка» */}
        <header className="sticky top-0 z-20 flex h-[68px] shrink-0 items-center gap-2 border-b border-[var(--border)] bg-surface/95 px-3 backdrop-blur md:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[#F1F5F9] md:hidden"
            aria-label="Открыть меню"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          {/*
            Не <h1>: настоящий h1 живёт в контенте страницы. Иначе на экране
            оказывалось два заголовка первого уровня (п.122 — доступность),
            а название дублировалось в топбаре и в теле (п.11).
            На мобильном показываем короткий контекст, на десктопе — пусто.
          */}
          <span className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-[-0.02em] text-ink md:hidden">
            {pageTitle(pathname)}
          </span>
          <span className="hidden min-w-0 flex-1 md:block" aria-hidden />

          {/* П.128: состояние сети видно всегда, а не только при обрыве */}
          <span
            role="status"
            aria-live="polite"
            title={online ? "Соединение есть" : "Нет сети — изменения не сохранятся"}
            className={`hidden h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium sm:flex ${
              online ? "text-[var(--muted)]" : "bg-[var(--danger-soft)] text-[var(--danger)]"
            }`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${online ? "bg-[var(--success)]" : "bg-[var(--danger)]"}`}
            />
            {online ? "онлайн" : "нет сети"}
          </span>

          <Link
            href="/clients"
            className="focus-ring hidden h-10 items-center gap-2 rounded-lg border border-[var(--border-strong)] px-3 text-[13.5px] font-medium text-[var(--muted)] transition-colors hover:border-primary hover:text-primary lg:flex"
          >
            <IconSearch size={16} />
            Поиск клиента
          </Link>

          <Link
            href="/today#notifications"
            title="Уведомления"
            aria-label="Уведомления"
            className="focus-ring relative grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--muted)] transition-colors hover:bg-[#F1F5F9] hover:text-ink"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
              <path d="M10.3 20a2 2 0 0 0 3.4 0" />
            </svg>
            {overdue > 0 && (
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[#EF4444]" />
            )}
          </Link>

          <Link
            href="/notes"
            className="focus-ring flex h-11 min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13.5px] font-semibold text-white transition-colors hover:bg-[var(--primary-hover)] sm:h-10 sm:min-h-10 sm:px-4"
          >
            <IconPlus size={17} strokeWidth={2.4} />
            <span className="hidden sm:inline">Новая заметка</span>
            <span className="sm:hidden">Заметка</span>
          </Link>
        </header>

        {/* П.128: при обрыве сети менеджер сразу видит, почему не сохраняется */}
        {!online && (
          <div
            role="alert"
            className="mx-3 mt-3 rounded-control border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] leading-snug text-[var(--danger)] md:mx-6"
          >
            Нет соединения с интернетом. Изменения не сохранятся, пока сеть не
            вернётся — текст заметки останется в редакторе.
          </div>
        )}

        {/* Пункт 10: никакой горизонтальной прокрутки всего приложения */}
        <main className="min-w-0 max-w-full flex-1 px-3 pb-24 pt-4 md:px-6 md:pb-8 md:pt-6">
          {children}
        </main>
      </div>

      {/* §8 (п.92-94): отдельная мобильная навигация с центральной кнопкой микрофона */}
      <MobileNav overdue={overdue} />
    </div>
  );
}
