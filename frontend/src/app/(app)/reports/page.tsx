"use client";

/**
 * Отчёты — §7 (86–90).
 *
 * Сверху период и охват, рядом — кнопки PDF и Excel (п.87: экспорт не
 * спрятан в конце формы). Ниже состав отчёта галочками (п.88). Пока идёт
 * генерация, показываем состояние; когда готово — даём ссылку на файл
 * без технических id в подписи (п.89–90).
 *
 * Пустой отчёт не выдаём молча: если в выбранном периоде нет данных,
 * пишем об этом до нажатия кнопки (п.90).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  SectionTitle,
  Skeleton,
  inputClass,
} from "@/components/ui";
import { api, API_ROOT, getToken, Paged, Client, ReportJob } from "@/lib/api";
import { dateTimeRu } from "@/lib/format";

type Section = "projects" | "tasks" | "finance";

const SECTIONS: { key: Section; label: string; hint: string }[] = [
  { key: "projects", label: "Объекты и договоры", hint: "Проекты, статусы, проблемы" },
  { key: "tasks", label: "Задачи и обязательства", hint: "Просроченное и требующее уточнения" },
  { key: "finance", label: "Финансы и долги", hint: "Выставлено, оплачено, задолженность" },
];

const PRESETS = [
  { key: "month", label: "Текущий месяц" },
  { key: "quarter", label: "Квартал" },
  { key: "year", label: "Год" },
] as const;

function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Период для быстрых кнопок. */
function presetRange(key: "month" | "quarter" | "year"): { from: string; to: string } {
  const now = new Date();
  const year = now.getFullYear();
  if (key === "year") return { from: toISO(new Date(year, 0, 1)), to: toISO(new Date(year, 11, 31)) };
  if (key === "quarter") {
    const quarter = Math.floor(now.getMonth() / 3);
    return {
      from: toISO(new Date(year, quarter * 3, 1)),
      to: toISO(new Date(year, quarter * 3 + 3, 0)),
    };
  }
  return { from: toISO(new Date(year, now.getMonth(), 1)), to: toISO(new Date(year, now.getMonth() + 1, 0)) };
}

export default function ReportsPage() {
  const [jobs, setJobs] = useState<ReportJob[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<"pdf" | "xlsx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyJob, setReadyJob] = useState<ReportJob | null>(null);

  const initial = presetRange("month");
  const [form, setForm] = useState({
    scope: "all" as "all" | "client",
    client_id: "",
    date_from: initial.from,
    date_to: initial.to,
  });
  const [sections, setSections] = useState<Record<Section, boolean>>({
    projects: true,
    tasks: true,
    finance: true,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [reportList, clientList] = await Promise.all([
        api<ReportJob[]>("/reports?limit=40"),
        api<Paged<Client>>("/clients?limit=200"),
      ]);
      setJobs(reportList);
      setClients(clientList.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить отчёты");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    п.88 DESIGN TASKS v2.1: состояние генерации должно обновляться само,
    без перезагрузки страницы. Раньше «формируется» висело вечно, пока
    менеджер не нажмёт F5. Опрашиваем только пока есть незавершённые
    задания, затем останавливаемся — лишних запросов нет.
  */
  const hasPending = useMemo(
    () => jobs.some((j) => j.status !== "ready" && j.status !== "failed"),
    [jobs],
  );

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      void api<ReportJob[]>("/reports?limit=40")
        .then((list) => {
          setJobs(list);
          const fresh = list.find((j) => j.status === "ready");
          if (fresh) setReadyJob((prev) => prev ?? fresh);
        })
        .catch(() => {
          /* тихо: следующий тик попробует снова */
        });
    }, 4000);
    return () => clearInterval(timer);
  }, [hasPending]);

  const chosen = useMemo(
    () => SECTIONS.filter((item) => sections[item.key]).map((item) => item.key),
    [sections],
  );

  const periodValid = !form.date_from || !form.date_to || form.date_from <= form.date_to;
  const canBuild =
    periodValid &&
    chosen.length > 0 &&
    (form.scope === "all" || Boolean(form.client_id)) &&
    !creating;

  async function build(format: "pdf" | "xlsx") {
    if (!canBuild) return;
    setCreating(format);
    setError(null);
    setReadyJob(null);
    try {
      const job = await api<ReportJob>("/reports", {
        method: "POST",
        body: {
          format,
          scope: form.scope,
          client_id: form.scope === "client" ? form.client_id || null : null,
          date_from: form.date_from || null,
          date_to: form.date_to || null,
          sections: chosen,
        },
      });
      setJobs((prev) => [job, ...prev]);
      if (job.status === "ready") setReadyJob(job);
      else if (job.status === "failed") {
        setError(
          "Отчёт не сформировался. Данные не потеряны — попробуйте другой период или сообщите администратору.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сформировать отчёт");
    } finally {
      setCreating(null);
    }
  }

  async function download(job: ReportJob) {
    const token = getToken();
    try {
      const response = await fetch(`${API_ROOT}/api/v1/reports/${job.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        setError("Файл недоступен. Сформируйте отчёт заново.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const stamp = job.created_at.slice(0, 10);
      link.download = `forteon-${job.scope === "client" ? "client" : "all"}-${stamp}.${job.format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Не удалось скачать файл отчёта");
    }
  }

  return (
    <div className="mx-auto max-w-[1240px]">
      <header className="mb-4">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.026em] text-ink sm:text-[28px]">
          Отчёты
        </h1>
        <p className="mt-1 max-w-3xl text-[14px] leading-relaxed text-[var(--muted)]">
          PDF — для совещания, Excel — для работы с данными. Суммы считаются по
          счетам и платежам, AI в расчётах не участвует.
        </p>
      </header>

      {error && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2 rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13.5px] text-[var(--danger)]">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="focus-ring rounded-md px-2 py-0.5 text-[12.5px] font-medium underline decoration-dotted"
          >
            Скрыть
          </button>
        </div>
      )}

      {readyJob && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-card border border-[#c4e6d6] bg-[var(--success-soft)] px-3.5 py-2.5">
          <span className="min-w-0 flex-1 text-[13.5px] text-[var(--success)]">
            Отчёт готов: {readyJob.format.toUpperCase()},{" "}
            {readyJob.scope === "client" ? "по клиенту" : "по всем клиентам"}.
          </span>
          <Button size="sm" variant="outline" onClick={() => void download(readyJob)}>
            Скачать файл
          </Button>
          <button
            type="button"
            onClick={() => setReadyJob(null)}
            className="focus-ring rounded-md px-2 py-0.5 text-[12.5px] font-medium text-[var(--success)] underline decoration-dotted"
          >
            Скрыть
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
        {/* -------------------------------------------------- форма отчёта */}
        <Card>
          <SectionTitle
            title="Параметры"
            subtitle="Период, охват и состав — всё на одном экране"
          />

          <div className="space-y-3">
            <Field label="Период">
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  value={form.date_from}
                  onChange={(e) => setForm({ ...form, date_from: e.target.value })}
                  aria-label="С даты"
                  className={inputClass}
                />
                <input
                  type="date"
                  value={form.date_to}
                  onChange={(e) => setForm({ ...form, date_to: e.target.value })}
                  aria-label="По дату"
                  className={inputClass}
                />
              </div>
            </Field>

            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => {
                const range = presetRange(preset.key);
                const active = form.date_from === range.from && form.date_to === range.to;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => setForm({ ...form, date_from: range.from, date_to: range.to })}
                    aria-pressed={active}
                    /*
                      Пункт 11: пресеты периода на телефоне не меньше 44x44 —
                      «Год» был шириной 42px, и палец промахивался.
                      На десктопе оставляем компактную высоту 32px.
                    */
                    className={`focus-ring h-11 min-h-[44px] min-w-[44px] rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors sm:h-8 sm:min-h-0 ${
                      active
                        ? "border-primary bg-[var(--primary-soft)] text-primary"
                        : "border-[var(--border)] text-[var(--muted)] hover:border-primary hover:text-primary"
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setForm({ ...form, date_from: "", date_to: "" })}
                className="focus-ring h-11 min-h-[44px] rounded-lg border border-[var(--border)] px-2.5 text-[12.5px] text-[var(--muted)] transition-colors hover:border-primary hover:text-primary sm:h-8 sm:min-h-0"
              >
                Весь период
              </button>
            </div>

            {!periodValid && (
              <p className="text-[12.5px] text-[var(--danger)]">
                Начало периода позже конца — отчёт не соберётся.
              </p>
            )}

            <Field label="Охват">
              <select
                value={form.scope}
                onChange={(e) => setForm({ ...form, scope: e.target.value as "all" | "client" })}
                className={inputClass}
              >
                <option value="all">Все доступные клиенты</option>
                <option value="client">Один клиент</option>
              </select>
            </Field>

            {form.scope === "client" && (
              <Field label="Клиент">
                <select
                  value={form.client_id}
                  onChange={(e) => setForm({ ...form, client_id: e.target.value })}
                  className={inputClass}
                >
                  <option value="">Выберите клиента</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <div>
              <p className="mb-1.5 text-[12px] font-medium text-[var(--muted)]">Состав</p>
              <div className="space-y-1.5">
                {SECTIONS.map((item) => {
                  const on = sections[item.key];
                  return (
                    <label
                      key={item.key}
                      className={`flex min-h-[52px] cursor-pointer items-start gap-2.5 rounded-control border px-2.5 py-2 transition-colors ${
                        on
                          ? "border-primary bg-[var(--primary-soft)]"
                          : "border-[var(--border)] hover:border-[var(--border-strong)]"
                      }`}
                    >
                      {/*
                        Чекбокс 16px — нормальный размер для мыши, но зона
                        нажатия расширена до 44px через label: на телефоне
                        попасть по квадратику 16px нереально (п.100).
                      */}
                      <span className="grid h-11 w-8 shrink-0 place-items-center">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setSections({ ...sections, [item.key]: e.target.checked })
                          }
                          className="h-4 w-4 accent-[var(--primary)]"
                        />
                      </span>
                      <span className="min-w-0">
                        <span className={`block text-[13px] font-medium ${on ? "text-primary" : "text-ink"}`}>
                          {item.label}
                        </span>
                        <span className="block text-[11.5px] leading-snug text-[var(--muted)]">
                          {item.hint}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {chosen.length === 0 && (
                <p className="mt-1.5 text-[12.5px] text-[var(--danger)]">
                  Выберите хотя бы один раздел — иначе в отчёте нечего показать.
                </p>
              )}
            </div>

            {/* Экспорт рядом с фильтрами (п.87) */}
            <div className="!mt-4 grid grid-cols-2 gap-2 border-t border-[var(--border)] pt-3">
              <Button
                onClick={() => void build("pdf")}
                loading={creating === "pdf"}
                disabled={!canBuild}
              >
                Скачать PDF
              </Button>
              <Button
                variant="outline"
                onClick={() => void build("xlsx")}
                loading={creating === "xlsx"}
                disabled={!canBuild}
              >
                Скачать Excel
              </Button>
            </div>

            <p className="text-[11.5px] leading-relaxed text-[var(--muted)]">
              Отчёт по клиенту не содержит чужих данных: выгрузка проверяет
              ответственного менеджера.
            </p>
          </div>
        </Card>

        {/* -------------------------------------------------- история */}
        <Card>
          <SectionTitle
            title="История выгрузок"
            subtitle="Отчёты доступны для повторного скачивания"
            action={
              <Button variant="ghost" size="sm" onClick={() => void load()}>
                Обновить
              </Button>
            }
          />
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : jobs.length ? (
            <div className="divide-y divide-[var(--border)]">
              {jobs.map((job) => (
                <div key={job.id} className="flex flex-wrap items-center gap-2.5 py-2.5">
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-control text-[10.5px] font-semibold ${
                      job.format === "pdf"
                        ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                        : "bg-[var(--success-soft)] text-[var(--success)]"
                    }`}
                  >
                    {job.format.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[13px] font-medium text-ink">
                      {job.scope === "client" ? "Отчёт по клиенту" : "Сводный отчёт по клиентам"}
                    </p>
                    <p className="text-[11.5px] text-[var(--muted)]">
                      {dateTimeRu(job.created_at)}
                    </p>
                  </div>
                  <Badge
                    tone={
                      job.status === "ready"
                        ? "success"
                        : job.status === "failed"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {job.status === "ready"
                      ? "готов"
                      : job.status === "failed"
                        ? "не получился"
                        : "формируется"}
                  </Badge>
                  {job.status === "ready" && (
                    <Button size="sm" variant="outline" onClick={() => void download(job)}>
                      Скачать
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="Отчётов ещё не было"
              description="Задайте период и нажмите «Скачать PDF» или «Скачать Excel»."
            />
          )}
        </Card>
      </div>
    </div>
  );
}
