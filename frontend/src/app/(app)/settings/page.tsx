"use client";

import { useCallback, useEffect, useState } from "react";

import { MailSettings } from "@/components/MailSettings";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Button, Card, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { api, getRefreshToken, refreshSession, Session } from "@/lib/api";
import { dateTimeRu } from "@/lib/format";
import {
  applyDensity,
  applyTheme,
  getAnimationsEnabled,
  getDensity,
  getTheme,
  setAnimationsEnabled,
  setDensity,
  setTheme,
  type Density,
  type Theme,
} from "@/lib/prefs";

export default function SettingsPage() {
  const { user, photoUrl, refreshPhoto } = useAuth();
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMessage, setPhotoMessage] = useState<{ error: boolean; text: string } | null>(null);

  async function updatePhoto(file?: File) {
    if (photoBusy) return;
    setPhotoBusy(true);
    setPhotoMessage(null);
    try {
      if (file) {
        if (file.size > 5 * 1024 * 1024) throw new Error("Фото должно быть не больше 5 МБ.");
        const data = new FormData();
        data.append("file", file);
        await api("/auth/avatar", { method: "POST", body: data });
      } else await api("/auth/avatar", { method: "DELETE" });
      refreshPhoto();
      setPhotoMessage({ error: false, text: file ? "Фото сохранено." : "Фото удалено." });
    } catch (error) {
      setPhotoMessage({ error: true, text: error instanceof Error ? error.message : "Не удалось обновить фото." });
    } finally {
      setPhotoBusy(false);
    }
  }
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionBusy, setSessionBusy] = useState<string | null>(null);
  const [sessionMessage, setSessionMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [animations, setAnimations] = useState(true);
  const [loading, setLoading] = useState(true);
  const [passwords, setPasswords] = useState({ current: "", next: "", repeat: "" });
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [theme, setThemeState] = useState<Theme>("system");
  const [density, setDensityState] = useState<Density>("cozy");

  useEffect(() => {
    setAnimations(getAnimationsEnabled());
    setThemeState(getTheme());
    setDensityState(getDensity());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const active = await api<Session[]>("/auth/sessions");
      if (!active.some((session) => session.is_current) && getRefreshToken() && await refreshSession()) {
        setSessions(await api<Session[]>("/auth/sessions"));
      } else setSessions(active);
    } catch (error) {
      setSessionMessage({ error: true, text: error instanceof Error ? error.message : "Не удалось загрузить сессии." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(sessionId?: string) {
    setSessionBusy(sessionId ?? "others");
    setSessionMessage(null);
    try {
      if (sessionId) {
        await api(`/auth/sessions/${sessionId}`, { method: "DELETE" });
        setSessions((current) => current.filter((session) => session.id !== sessionId));
        setSessionMessage({ error: false, text: "Сессия завершена." });
      } else {
        const active = await api<Session[]>("/auth/sessions/revoke-others", {
          method: "POST",
          body: { refresh_token: getRefreshToken() },
        });
        setSessions(active);
        setSessionMessage({ error: false, text: "Остальные сессии завершены." });
      }
    } catch (error) {
      setSessionMessage({ error: true, text: error instanceof Error ? error.message : "Не удалось завершить сессии." });
    } finally {
      setSessionBusy(null);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    if (passwords.next !== passwords.repeat) {
      setMessage({ tone: "error", text: "Новый пароль и подтверждение не совпадают" });
      return;
    }
    if (passwords.next.length < 8) {
      setMessage({ tone: "error", text: "Пароль должен содержать не менее 8 символов" });
      return;
    }
    setSaving(true);
    try {
      await api("/auth/password", {
        method: "POST",
        body: { current_password: passwords.current, new_password: passwords.next },
      });
      setPasswords({ current: "", next: "", repeat: "" });
      setMessage({ tone: "ok", text: "Пароль обновлён" });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "Не удалось сменить пароль" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1000px] space-y-4">
      <header>
        <h1 className="text-[23px] font-semibold tracking-[-0.025em] text-ink">Настройки</h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">Устройства, часовой пояс и доступ</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <SectionTitle title="Профиль" subtitle="Данные учётной записи" />
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {photoUrl && <img src={photoUrl} alt="Фото профиля" className="h-12 w-12 rounded-full object-cover" />}
            <label className="focus-within:ring-2 focus-within:ring-primary inline-flex min-h-11 cursor-pointer items-center rounded-control border border-[var(--border-strong)] px-3 text-sm font-medium">
              <input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy} className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void updatePhoto(file);
                  event.target.value = "";
                }} />
              {photoUrl ? "Заменить фото" : "Добавить фото"}
            </label>
            {photoUrl && <Button type="button" size="sm" variant="ghost" disabled={photoBusy} onClick={() => void updatePhoto()}>Удалить фото</Button>}
          </div>
          {photoMessage && <p role={photoMessage.error ? "alert" : "status"} className="mb-3 text-sm text-[var(--muted)]">{photoMessage.text}</p>}
          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Имя</dt>
              <dd className="font-medium text-ink">{user?.full_name ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">E-mail</dt>
              <dd className="text-ink">{user?.email ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-[var(--muted)]">Роль</dt>
              <dd>
                <Badge tone={user?.role === "admin" ? "primary" : "neutral"}>
                  {user?.role === "admin" ? "Администратор" : "Менеджер"}
                </Badge>
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--muted)]">Часовой пояс</dt>
              <dd className="text-ink">{user?.timezone ?? "—"}</dd>
            </div>
          </dl>
          <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--muted)]">
            Часовой пояс применяется к относительным датам в заметках: «завтра», «в пятницу».
          </p>
        </Card>

        <Card>
          <SectionTitle title="Смена пароля" subtitle="Argon2id, минимум 8 символов" />
          <form onSubmit={changePassword} className="space-y-2.5">
            <Field label="Текущий пароль">
              <input
                type="password"
                value={passwords.current}
                onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
                className={inputClass}
                required
              />
            </Field>
            <Field label="Новый пароль">
              <input
                type="password"
                value={passwords.next}
                onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
                className={inputClass}
                required
                minLength={8}
              />
            </Field>
            <Field label="Повтор нового пароля">
              <input
                type="password"
                value={passwords.repeat}
                onChange={(e) => setPasswords({ ...passwords, repeat: e.target.value })}
                className={inputClass}
                required
                minLength={8}
              />
            </Field>
            {message && (
              <p
                className={`text-[12px] ${
                  message.tone === "ok" ? "text-[var(--success)]" : "text-[var(--danger)]"
                }`}
              >
                {message.text}
              </p>
            )}
            <Button type="submit" loading={saving} size="sm">
              Обновить пароль
            </Button>
          </form>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <SectionTitle title="Оформление" subtitle="Тема и плотность списков" />
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-[12px] font-medium text-[var(--muted)]">Тема</p>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { key: "light", label: "Светлая" },
                    { key: "dark", label: "Тёмная" },
                    { key: "system", label: "Как в системе" },
                  ] as { key: Theme; label: string }[]
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setTheme(item.key);
                      setThemeState(item.key);
                      applyTheme(item.key);
                    }}
                    aria-pressed={theme === item.key}
                    className={`focus-ring h-11 min-h-[44px] rounded-lg px-3.5 text-[13.5px] font-medium transition-colors sm:h-9 sm:min-h-9 ${
                      theme === item.key
                        ? "bg-primary text-white"
                        : "border border-[var(--border-strong)] text-ink hover:border-primary hover:text-primary"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] text-[var(--muted)]">
                «Как в системе» следует за настройкой Windows. Выбор запоминается на этом устройстве.
              </p>
            </div>

            <div>
              <p className="mb-2 text-[12px] font-medium text-[var(--muted)]">Плотность списков</p>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { key: "cozy", label: "Свободно" },
                    { key: "compact", label: "Компактно" },
                  ] as { key: Density; label: string }[]
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setDensity(item.key);
                      setDensityState(item.key);
                      applyDensity(item.key);
                    }}
                    aria-pressed={density === item.key}
                    className={`focus-ring h-11 min-h-[44px] rounded-lg px-3.5 text-[13.5px] font-medium transition-colors sm:h-9 sm:min-h-9 ${
                      density === item.key
                        ? "bg-primary text-white"
                        : "border border-[var(--border-strong)] text-ink hover:border-primary hover:text-primary"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] text-[var(--muted)]">
                Компактно — меньше отступы в задачах и клиентах: больше строк на экране.
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
              <span id="motion-preference-label" className="text-sm font-medium text-ink">Анимации интерфейса</span>
              <Button type="button" variant="outline" size="sm" role="switch" aria-checked={animations}
                aria-labelledby="motion-preference-label" onClick={() => {
                  setAnimationsEnabled(!animations);
                  setAnimations(!animations);
                }}>
                {animations ? "Включены" : "Выключены"}
              </Button>
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle title="Горячие клавиши" subtitle="Работают на всём сайте" />
          <ul className="space-y-2 text-[13px] text-[var(--muted)]">
            <li className="flex items-center gap-2">
              <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px] text-ink">N</kbd>
              новая заметка
            </li>
            <li className="flex items-center gap-2">
              <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px] text-ink">/</kbd>
              поиск клиентов
            </li>
            <li className="flex items-center gap-2">
              <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px] text-ink">Ctrl+K</kbd>
              командная палитра
            </li>
            <li className="flex items-center gap-2">
              <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[11px] text-ink">Esc</kbd>
              закрыть окно
            </li>
          </ul>
        </Card>
      </div>

      <MailSettings />

      <Card>
        <SectionTitle
          title="Устройства и сессии"
          subtitle="Активные входы в аккаунт"
          action={sessions.length > 1 && (
            <Button size="sm" variant="outline" disabled={Boolean(sessionBusy)}
              loading={sessionBusy === "others"} onClick={() => void revoke()}>
              Завершить остальные сеансы
            </Button>
          )}
        />
        {sessionMessage && (
          <p role={sessionMessage.error ? "alert" : "status"}
            className={`mb-2 text-sm ${sessionMessage.error ? "text-[var(--danger)]" : "text-[var(--success)]"}`}>
            {sessionMessage.text}
          </p>
        )}
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : sessions.length ? (
          <div className="divide-y divide-[var(--border)]">
            {sessions.map((session) => (
              <div key={session.id} className="flex flex-wrap items-center gap-2.5 py-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#f1f4f9] text-[var(--muted)]">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <rect x="3" y="4" width="18" height="13" rx="2" />
                    <path d="M8 21h8M12 17v4" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium text-ink">
                    {session.device_label || "Устройство"}
                  </p>
                  <p className="truncate text-[11px] text-[var(--muted)]">
                    {session.user_agent || "—"} · создана {dateTimeRu(session.created_at)}
                  </p>
                </div>
                {session.is_current ? (
                  <Badge tone="success">Текущая сессия</Badge>
                ) : (
                  <Button size="sm" variant="outline" disabled={Boolean(sessionBusy)}
                    loading={sessionBusy === session.id} onClick={() => void revoke(session.id)}>
                    Завершить
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-[var(--muted)]">Активных сессий нет.</p>
        )}
      </Card>
    </div>
  );
}
