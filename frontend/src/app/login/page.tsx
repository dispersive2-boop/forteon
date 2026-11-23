"use client";

import { useState, type FormEvent } from "react";

import { ForteOnBrand } from "@/components/ForteOnBrand";
import { IconCheck, IconClients, IconMic, IconMore, IconPlanner, IconToday } from "@/components/icons";
import { Button, inputClass } from "@/components/ui";
import { ApiFailure, login } from "@/lib/api";

const previewTasks = [
  { title: "Согласовать смету", client: "Комплекс «Лесной»", detail: "10:30", state: "open" },
  { title: "Отправить документы", client: "БЦ «Горизонт»", detail: "14:00", state: "open" },
  { title: "Проверить оплату", client: "Проект «Маяк»", detail: "Выполнено", state: "done" },
];

const previewNav = [
  { label: "Сегодня", Icon: IconToday },
  { label: "Клиенты", Icon: IconClients },
  { label: "Заметка", Icon: IconMic },
  { label: "Планы", Icon: IconPlanner },
  { label: "Ещё", Icon: IconMore },
];

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await login(email.trim(), password);
      window.location.href = "/today";
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Не удалось войти. Проверьте соединение с API.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-canvas px-4 py-6 sm:px-8 sm:py-10">
      <div className="grid w-full max-w-[460px] overflow-hidden rounded-[26px] border border-[var(--border)] bg-surface shadow-[0_24px_80px_-40px_rgba(5,15,40,0.5)] lg:max-w-[1060px] lg:grid-cols-[1.12fr_1fr]">
        <aside className="relative hidden grid-cols-[1fr] place-items-center overflow-hidden bg-[#101d38] px-8 pb-8 pt-7 text-white lg:grid">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_95%,#245ad5_0%,#142746_56%,#101d38_88%)]"
          />
          <div className="relative w-full max-w-[430px]">
            <ForteOnBrand />
            <p className="mt-3 max-w-[21ch] text-[30px] font-semibold leading-[1.12] tracking-[-0.035em] xl:text-[34px]">
              Работа с клиентами
            </p>
            <p className="mt-2.5 max-w-[35ch] text-[15px] leading-relaxed text-[#c3d5f3]">
              Планируйте задачи, фиксируйте договорённости и отслеживайте оплаты.
            </p>
          </div>
          <PhonePreview />
        </aside>

        <section aria-labelledby="login-title" className="flex min-w-0 items-center px-5 py-8 sm:px-9 sm:py-11 lg:px-12">
          <div className="mx-auto w-full max-w-[356px]">
            <div className="mb-6 lg:hidden"><ForteOnBrand variant="light" /></div>
            <h1 id="login-title" className="text-[30px] font-semibold leading-tight tracking-[-0.035em] text-ink">
              Вход в ForteOn
            </h1>
            <p className="mt-2 text-[15px] leading-relaxed text-[var(--muted)]">
              Введите данные рабочей учётной записи.
            </p>

            <form onSubmit={submit} className="mt-6 space-y-4" aria-busy={loading}>
              <div>
                <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-ink">Рабочая почта</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@company.ru"
                  className={`${inputClass} h-12 !text-base`}
                />
              </div>
              <div>
                <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-ink">Пароль</label>
                <div className="relative">
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className={`${inputClass} h-12 !text-base !pr-[100px]`}
                  />
                  <button
                    type="button"
                    aria-controls="password"
                    aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                    onClick={() => setShowPassword((shown) => !shown)}
                    className="focus-ring absolute inset-y-0 right-0 rounded-control px-3 text-[13px] font-medium text-[var(--muted)] transition-colors hover:text-ink"
                  >
                    {showPassword ? "Скрыть" : "Показать"}
                  </button>
                </div>
              </div>

              {error && (
                <p role="alert" className="rounded-control bg-[var(--danger-soft)] px-3.5 py-2.5 text-sm leading-snug text-[var(--danger)]">
                  {error}
                </p>
              )}

              <Button type="submit" size="lg" loading={loading} className="w-full">
                {loading ? "Входим…" : "Войти"}
              </Button>
            </form>

            <p className="mt-5 border-t border-[var(--border)] pt-4 text-sm leading-relaxed text-[var(--muted)]">
              Для восстановления доступа обратитесь к администратору.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}

function PhonePreview() {
  return (
    <figure
      aria-label="Пример экрана «Сегодня» в мобильном ForteOn"
      className="relative mt-5 w-[238px] rounded-[34px] border border-[#91acd5]/70 bg-[#1a2b48] p-[5px] shadow-[0_20px_45px_-12px_#020a20]"
    >
      <div className="flex flex-col min-h-[402px] overflow-hidden rounded-[29px] bg-[rgb(240,244,252)] text-[#15223a]">
        <div className="relative flex h-8 items-center bg-[rgb(251,252,255)] px-4 text-[11px] font-semibold">
          <span aria-hidden="true">9:41</span>
          <span aria-hidden="true" className="absolute left-1/2 top-2.5 h-3 w-12 -translate-x-1/2 rounded-full bg-[#14223b]" />
          <span aria-hidden="true" className="ml-auto h-2 w-3.5 rounded-[3px] border border-[#526078] bg-[#526078]/70" />
        </div>

        <div className="border-b border-[#dde5f2] bg-[rgb(251,252,255)] px-3.5 pb-2.5 pt-1">
          <p className="text-[19px] font-semibold leading-tight tracking-tight">Сегодня</p>
        </div>

        <div className="grid grid-cols-2 gap-1.5 px-2.5 pt-2.5">
          <div className="rounded-lg border border-[#dce6f5] bg-[rgb(255,255,255)] px-2 py-1.5">
            <p className="text-sm font-semibold text-[#2559c4]">2</p>
            <p className="text-[10px] text-[#596c89]">В работе</p>
          </div>
          <div className="rounded-lg border border-[#dce6f5] bg-[rgb(255,255,255)] px-2 py-1.5">
            <p className="text-sm font-semibold text-[#22684e]">1</p>
            <p className="text-[10px] text-[#596c89]">Выполнено</p>
          </div>
        </div>

        <p className="px-3 pt-2.5 text-[11px] font-semibold text-[#344f80]">Задачи на день</p>
        <ul className="flex-1 space-y-1.5 px-2.5 pb-4 pt-1.5">
          {previewTasks.map((task) => {
            const done = task.state === "done";
            return (
              <li key={task.title} className="flex items-center gap-2 rounded-lg border border-[#dce6f5] bg-[rgb(255,255,255)] px-2 py-2">
                <span aria-hidden="true" className={`grid h-5 w-5 shrink-0 place-items-center rounded-md border ${done ? "border-[#b8dccc] bg-[rgb(232,245,239)] text-[#22684e]" : "border-[#afc4e8]"}`}>
                  {done && <IconCheck size={13} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold leading-tight">{task.title}</span>
                  <span className="mt-0.5 block text-[10px] text-[#596c89]">{task.client}</span>
                </span>
                <span className={`shrink-0 text-[9.5px] font-medium ${done ? "text-[#22684e]" : "text-[#344f80]"}`}>{task.detail}</span>
              </li>
            );
          })}
        </ul>

        <div className="grid grid-cols-5 items-start border-t border-[#dce6f5] bg-[rgb(255,255,255)] px-1 pt-2.5" aria-hidden="true">
          {previewNav.map(({ label, Icon }, index) => (
            <span key={label} className={`flex flex-col items-center gap-1 ${index === 0 ? "text-[#2559c4]" : "text-[#576b8c]"}`}>
              <span className={index === 2 ? "-mt-4 grid h-9 w-9 place-items-center rounded-full border-2 border-white bg-[#265cd2] text-white shadow-sm" : "grid h-[17px] place-items-center"}>
                <Icon size={16} />
              </span>
              <span className="text-[8px] font-semibold leading-none">{label}</span>
            </span>
          ))}
        </div>
        <div aria-hidden="true" className="flex justify-center bg-[rgb(255,255,255)] pb-1.5 pt-2">
          <span className="h-[3px] w-[72px] rounded-full bg-[#192944]" />
        </div>
      </div>
    </figure>
  );
}
