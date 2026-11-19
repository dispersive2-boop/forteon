"use client";

import { useCallback, useEffect, useState } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Skeleton,
  inputClass,
} from "@/components/ui";
import { api, API_ROOT, getToken, Paged, Client, ReportJob } from "@/lib/api";
import { dateTimeRu } from "@/lib/format";

export default function ReportsPage() {
  const [jobs, setJobs] = useState<ReportJob[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    format: "pdf" as "pdf" | "xlsx",
    scope: "all" as "all" | "client",
    client_id: "",
    date_from: "",
    date_to: "",
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

  async function createReport(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api<ReportJob>("/reports", {
        method: "POST",
        body: {
          format: form.format,
          scope: form.scope,
          client_id: form.scope === "client" ? form.client_id || null : null,
          date_from: form.date_from || null,
          date_to: form.date_to || null,
        },
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сформировать отчёт");
    } finally {
      setCreating(false);
    }
  }

  async function download(job: ReportJob) {
    const token = getToken();
    const response = await fetch(`${API_ROOT}/api/v1/reports/${job.id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      setError("Не удалось скачать файл отчёта");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `forteon-report-${job.id.slice(0, 8)}.${job.format}`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <header>
        <h1 className="text-[23px] font-semibold tracking-[-0.025em] text-ink">Отчёты</h1>
        <p className="mt-1 text-[13px] text-[var(--muted)]">
          PDF для совещания и XLSX с листами «Клиенты», «Проекты», «Задачи», «Финансы», «Проблемы».
        </p>
      </header>

      {error && (
        <div className="rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card>
          <SectionTitle title="Новый отчёт" subtitle="Формируется из проверенных данных" />
          <form onSubmit={createReport} className="space-y-3">
            <Field label="Формат">
              <div className="grid grid-cols-2 gap-2">
                {(["pdf", "xlsx"] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    onClick={() => setForm({ ...form, format })}
                    className={`focus-ring h-10 rounded-control border text-[13px] font-medium transition-colors ${
                      form.format === format
                        ? "border-primary bg-[var(--primary-soft)] text-primary"
                        : "border-[var(--border-strong)] text-[var(--muted)] hover:border-primary"
                    }`}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </div>
            </Field>

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

            <div className="grid grid-cols-2 gap-2">
              <Field label="С даты">
                <input
                  type="date"
                  value={form.date_from}
                  onChange={(e) => setForm({ ...form, date_from: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field label="По дату">
                <input
                  type="date"
                  value={form.date_to}
                  onChange={(e) => setForm({ ...form, date_to: e.target.value })}
                  className={inputClass}
                />
              </Field>
            </div>

            <Button
              type="submit"
              className="w-full"
              loading={creating}
              disabled={form.scope === "client" && !form.client_id}
            >
              Сформировать отчёт
            </Button>
          </form>

          <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--muted)]">
            Отчёт по клиенту не содержит чужих данных. Выгрузка SCOPED выполняется с проверкой owner_id.
          </p>
        </Card>

        <Card>
          <SectionTitle
            title="История выгрузок"
            subtitle="Последние сформированные отчёты"
            action={<Button variant="ghost" size="sm" onClick={() => void load()}>Обновить</Button>}
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
                    <p className="truncate text-[13px] font-medium text-ink">
                      {job.scope === "client" ? "Отчёт по клиенту" : "Сводный отчёт"}
                    </p>
                    <p className="text-[11.5px] text-[var(--muted)]">{dateTimeRu(job.created_at)}</p>
                  </div>
                  <Badge
                    tone={job.status === "ready" ? "success" : job.status === "failed" ? "danger" : "warning"}
                  >
                    {job.status === "ready" ? "готов" : job.status === "failed" ? "ошибка" : "в работе"}
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
              description="Сформируйте первый отчёт — он появится здесь и будет доступен для скачивания."
            />
          )}
        </Card>
      </div>
    </div>
  );
}
