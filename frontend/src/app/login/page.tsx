"use client";

import { useState } from "react";

import { Button, Field, inputClass } from "@/components/ui";
import { ApiFailure, login } from "@/lib/api";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email.trim(), password);
      window.location.href = "/today";
    } catch (err) {
      setError(
        err instanceof ApiFailure
          ? err.message
          : "Не удалось войти. Проверьте соединение с API.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      {/* Левая тёмная панель */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-[var(--sidebar)] p-12 lg:flex">
        {/* Свечение фона */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-40 top-0 h-[560px] w-[560px] rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, #2563EB 0%, transparent 68%)" }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 right-0 h-[460px] w-[460px] rounded-full opacity-25 blur-3xl"
          style={{ background: "radial-gradient(circle, #38BDF8 0%, transparent 70%)" }}
        />

        <div className="relative flex items-center gap-3">
          {/* Знак из брендбука: свободно, без плитки — как в референсе */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-mark.svg"
            alt=""
            width={58}
            height={58}
            className="h-[58px] w-[58px] shrink-0 drop-shadow-[0_3px_14px_rgba(96,165,250,0.42)]"
          />
          <span className="text-[30px] font-semibold leading-none tracking-[-0.035em] text-white">
            Forte<span className="text-[#60A5FA]">On</span>
          </span>
        </div>

        <div className="relative max-w-[560px]">
          <h1 className="text-[40px] font-semibold leading-[1.14] tracking-[-0.035em] text-white">
            Заметка превращается
            <br />
            в обязательство, задачу
            <br />
            и контроль результата
          </h1>
          <p className="mt-5 max-w-[470px] text-[15.5px] leading-relaxed text-white/65">
            Специализированная CRM для сопровождения действующих клиентов.
            Ежедневный план — центральный интерфейс, ручное заполнение форм —
            минимально.
          </p>

          <ul className="mt-8 space-y-3.5">
            {[
              "Задачи извлекаются из заметки автоматически",
              "Просрочки, обещания клиентов и платежи на одном экране",
              "Отчёты PDF и XLSX по проверенным данным",
            ].map((line) => (
              <li key={line} className="flex items-start gap-3 text-[14.5px] text-white/80">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#38BDF8]/20 text-[#7DD3FC]">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                {line}
              </li>
            ))}
          </ul>

          {/* Мокап телефона */}
          <PhoneMock />
        </div>

        <p className="relative text-[12px] text-white/35">
          MVP v1.0 · модульный монолит · RouterAI
        </p>
      </div>

      {/* Форма входа */}
      <div className="flex items-center justify-center bg-canvas px-5 py-12">
        <div className="w-full max-w-[404px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-mark.svg"
              alt="ForteOn"
              width={38}
              height={38}
              className="h-[38px] w-[38px]"
            />
            <span className="text-[22px] font-semibold tracking-[-0.025em] text-ink">
              Forte<span className="text-primary">On</span>
            </span>
          </div>

          <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.028em] text-ink">
            Вход в систему
          </h2>
          <p className="mt-2 text-[14px] leading-relaxed text-[var(--muted)]">
            Используйте рабочую учётную запись. Восстановление доступа — через
            администратора.
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <Field label="E-mail">
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.ru"
                className={`${inputClass} h-12`}
              />
            </Field>
            <Field label="Пароль">
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className={`${inputClass} h-12`}
              />
            </Field>

            {error && (
              <div className="rounded-control bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] leading-snug text-[var(--danger)]">
                {error}
              </div>
            )}

            <Button type="submit" size="lg" loading={loading} className="w-full">
              Войти
            </Button>
          </form>

          <p className="mt-7 text-[11.5px] leading-snug text-[var(--muted)]">
            Учётные данные выдаёт администратор. Пароль в интерфейсе не
            отображается и не подставляется автоматически.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Мобильный мокап: главный экран продукта. */
function PhoneMock() {
  return (
    <div className="relative mt-12 flex justify-start">
      <div className="relative w-[276px] shrink-0 rounded-[38px] border border-white/12 bg-[#0B1120] p-2.5 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.8)]">
        <div className="overflow-hidden rounded-[30px] bg-[var(--canvas)]">
          {/* Строка статуса */}
          <div className="flex items-center justify-between bg-[var(--sidebar)] px-4 pb-2 pt-3">
            <span className="text-[11px] font-semibold text-white">9:41</span>
            <div className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-white/70" />
              <span className="h-1.5 w-1.5 rounded-full bg-white/70" />
              <span className="h-1.5 w-3 rounded-sm bg-white/70" />
            </div>
          </div>

          {/* Шапка */}
          <div className="flex items-center gap-2.5 bg-[var(--sidebar)] px-4 pb-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.svg" alt="" width={26} height={26} className="h-[26px] w-[26px]" />
            <span className="text-[15px] font-semibold text-white">
              Forte<span className="text-[#60A5FA]">On</span>
            </span>
          </div>

          {/* Содержимое */}
          <div className="space-y-2 p-3">
            <div className="rounded-xl bg-surface p-3 shadow-soft">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-[#EFF6FF] text-[#2563EB]">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <rect x="3" y="4" width="18" height="17" rx="2.5" />
                    <path d="M8 2v4M16 2v4M3 10h18" />
                  </svg>
                </span>
                <span className="text-[11px] font-semibold text-ink">Напоминание</span>
              </div>
              <p className="text-[10.5px] leading-snug text-[var(--muted)]">
                Сегодня, 11:00 — Позвонить клиенту «Экспоцентр»
              </p>
            </div>

            <div className="rounded-xl bg-surface p-3 shadow-soft">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-[#ECFDF5] text-[#22C55E]">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                </span>
                <span className="text-[11px] font-semibold text-ink">Задача выполнена</span>
              </div>
              <p className="text-[10.5px] leading-snug text-[var(--muted)]">
                Отправить документы — завершено
              </p>
            </div>

            <div className="rounded-xl bg-surface p-3 shadow-soft">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md bg-[#FEF2F2] text-[#EF4444]">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M12 9v4M12 17h.01" />
                    <path d="M10.3 3.9 2.6 17.4A1.9 1.9 0 0 0 4.3 20.2h15.4a1.9 1.9 0 0 0 1.7-2.8L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" />
                  </svg>
                </span>
                <span className="text-[11px] font-semibold text-ink">Просрочено</span>
              </div>
              <p className="text-[10.5px] leading-snug text-[var(--muted)]">
                Оплата по договору №154 — «СтройПроф»
              </p>
            </div>
          </div>

          {/* Нижняя панель */}
          <div className="flex items-center justify-around border-t border-[var(--border)] bg-surface px-2 py-2.5">
            {[
              { icon: "home", label: "Сегодня", active: true },
              { icon: "users", label: "Клиенты", active: false },
              { icon: "note", label: "Задачи", active: false },
              { icon: "more", label: "Ещё", active: false },
            ].map((item) => (
              <div
                key={item.label}
                className={`flex flex-col items-center gap-0.5 ${
                  item.active ? "text-[#2563EB]" : "text-[#94A3B8]"
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {item.icon === "home" && <path d="M3.5 10.5 12 3.5l8.5 7M5.5 9.8V20h13V9.8" />}
                  {item.icon === "users" && (
                    <>
                      <circle cx="9" cy="8" r="3.2" />
                      <path d="M3 19c.5-3.2 2.8-4.8 6-4.8s5.5 1.6 6 4.8" />
                    </>
                  )}
                  {item.icon === "note" && (
                    <>
                      <path d="m3.4 7.2 1.8 1.8 3.2-3.4" />
                      <path d="M11.8 7.4h8.8M11.8 15.4h8.8" />
                    </>
                  )}
                  {item.icon === "more" && (
                    <>
                      <circle cx="5" cy="12" r="1.3" />
                      <circle cx="12" cy="12" r="1.3" />
                      <circle cx="19" cy="12" r="1.3" />
                    </>
                  )}
                </svg>
                <span className="text-[8.5px] font-medium leading-none">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Плавающая кнопка микрофона */}
      <div className="absolute bottom-14 right-[calc(50%-138px)] grid h-11 w-11 place-items-center rounded-full bg-[#2563EB] shadow-[0_12px_28px_-8px_rgba(37,99,235,0.8)]">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <rect x="9" y="2.6" width="6" height="11.2" rx="3" />
          <path d="M5.2 11.2a6.8 6.8 0 0 0 13.6 0M12 18v3.4" />
        </svg>
      </div>
    </div>
  );
}
