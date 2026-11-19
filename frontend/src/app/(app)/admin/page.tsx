"use client";

import { useCallback, useEffect, useState } from "react";

import { Badge, Button, Card, EmptyState, Field, SectionTitle, Skeleton, inputClass } from "@/components/ui";
import { api, Client, Paged, ReportJob } from "@/lib/api";
import { dateTimeRu } from "@/lib/format";

type AdminUser = {
  id: string;
  email: string;
  full_name: string;
  role: "manager" | "admin";
  is_active: boolean;
  timezone: string;
  created_at: string | null;
};

type AuditEntry = {
  id: string;
  actor_id: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
};

type Stats = { users: number; clients: number; tasks_open: number; tasks_overdue: number };

type ImportResult = {
  source: string;
  clients_created: number;
  clients_reused: number;
  projects_created: number;
  tasks_created: number;
  problems_created: number;
  skipped_rows: number[];
};

type AiSettings = {
  model: string;
  enabled: boolean;
  max_tokens: number;
  provider: string;
  key_configured: boolean;
  timeout_seconds: number;
  json_mode: boolean;
  watcher_enabled: boolean;
  watcher_interval: number;
};

type AiHealth = {
  ok: boolean;
  provider: string;
  model: string;
  status?: number;
  reason?: string;
};

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [newUser, setNewUser] = useState({ email: "", full_name: "", password: "", role: "manager" });
  const [creating, setCreating] = useState(false);
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null);
  const [checkingAi, setCheckingAi] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [userList, clientList, auditList, statData, aiData] = await Promise.all([
        api<AdminUser[]>("/admin/users"),
        api<Paged<Client>>("/clients?limit=200"),
        api<AuditEntry[]>("/admin/audit-log?limit=40"),
        api<Stats>("/admin/stats"),
        api<AiSettings>("/admin/ai-settings"),
      ]);
      setUsers(userList);
      setClients(clientList.items);
      setAudit(auditList);
      setStats(statData);
      setAi(aiData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Недостаточно прав или API недоступен");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    try {
      await api("/admin/users", {
        method: "POST",
        body: { ...newUser, timezone: "Asia/Yekaterinburg" },
      });
      setNewUser({ email: "", full_name: "", password: "", role: "manager" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать пользователя");
    } finally {
      setCreating(false);
    }
  }

  async function toggleUser(user: AdminUser) {
    await api(`/admin/users/${user.id}`, { method: "PATCH", body: { is_active: !user.is_active } });
    await load();
  }

  async function transferClient(clientId: string, toUserId: string) {
    if (!toUserId) return;
    await api(`/admin/clients/${clientId}/transfer`, {
      method: "POST",
      body: { to_user_id: toUserId, comment: "Передача через панель администратора" },
    });
    await load();
  }

  async function checkAi() {
    setCheckingAi(true);
    try {
      const result = await api<AiHealth>("/admin/ai-health");
      setAiHealth(result);
    } catch (err) {
      setAiHealth({
        ok: false,
        provider: ai?.provider ?? "unknown",
        model: ai?.model ?? "unknown",
        reason: err instanceof Error ? err.message : "ошибка запроса",
      });
    } finally {
      setCheckingAi(false);
    }
  }

  async function syncNotes() {
    setSyncing(true);
    setSynced(null);
    try {
      const result = await api<{ processed: number }>("/admin/ai-sync-notes", {
        method: "POST",
      });
      setSynced(result.processed ?? 0);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось разобрать заметки");
    } finally {
      setSyncing(false);
    }
  }

  async function runImport() {
    setImporting(true);
    setImportResult(null);
    try {
      const result = await api<ImportResult>("/admin/import/grishanov", {
        method: "POST",
        body: new FormData(),
      });
      setImportResult(result);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Импорт не выполнен");
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[1240px] space-y-4">
        <Skeleton className="h-16 rounded-card" />
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-card" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }

  if (error && !stats) {
    return (
      <Card>
        <EmptyState title="Доступ ограничен" description={error} />
      </Card>
    );
  }

  const managers = users.filter((u) => u.role === "manager");

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[23px] font-semibold tracking-[-0.025em] text-ink">Администрирование</h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Учётные записи, передачи клиентов, импорт и журнал аудита
          </p>
        </div>
        <Button variant="outline" onClick={() => void runImport()} loading={importing}>
          Импортировать отчёт Гришанова
        </Button>
      </header>

      {error && (
        <div className="rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {importResult && (
        <Card className="border-[#c4e6d6] bg-[var(--success-soft)]">
          <SectionTitle title="Импорт выполнен" subtitle={importResult.source} />
          <div className="grid grid-cols-2 gap-2 text-[12.5px] md:grid-cols-5">
            <Stat label="Клиентов создано" value={importResult.clients_created} />
            <Stat label="Клиентов найдено" value={importResult.clients_reused} />
            <Stat label="Проектов" value={importResult.projects_created} />
            <Stat label="Задач" value={importResult.tasks_created} />
            <Stat label="Проблем" value={importResult.problems_created} />
          </div>
          <p className="mt-2 text-[11.5px] text-[var(--muted)]">
            Импорт идемпотентен: повторный запуск не создаёт дублей клиентов и задач.
          </p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MiniKpi label="Пользователи" value={stats?.users ?? 0} />
        <MiniKpi label="Клиенты" value={stats?.clients ?? 0} />
        <MiniKpi label="Открытые задачи" value={stats?.tasks_open ?? 0} tone="primary" />
        <MiniKpi label="Всего с датой" value={stats?.tasks_overdue ?? 0} tone="warning" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Card>
          <SectionTitle title="Пользователи" subtitle="Менеджеры видят только своих клиентов" />
          <div className="divide-y divide-[var(--border)]">
            {users.map((user) => (
              <div key={user.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{user.full_name}</p>
                  <p className="truncate text-[11.5px] text-[var(--muted)]">{user.email}</p>
                </div>
                <Badge tone={user.role === "admin" ? "primary" : "neutral"}>
                  {user.role === "admin" ? "Админ" : "Менеджер"}
                </Badge>
                <Badge tone={user.is_active ? "success" : "danger"}>
                  {user.is_active ? "активен" : "отключён"}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => void toggleUser(user)}>
                  {user.is_active ? "Отключить" : "Включить"}
                </Button>
              </div>
            ))}
          </div>

          <form onSubmit={createUser} className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
            <p className="text-[12px] font-medium text-[var(--muted)]">Новый пользователь</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={newUser.full_name}
                onChange={(e) => setNewUser({ ...newUser, full_name: e.target.value })}
                placeholder="ФИО"
                className={inputClass}
                required
              />
              <input
                type="email"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                placeholder="email@company.ru"
                className={inputClass}
                required
              />
              <input
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                placeholder="Пароль (8+)"
                className={inputClass}
                minLength={8}
                required
              />
              <select
                value={newUser.role}
                onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                className={inputClass}
              >
                <option value="manager">Менеджер</option>
                <option value="admin">Администратор</option>
              </select>
            </div>
            <Button type="submit" size="sm" loading={creating}>
              Создать пользователя
            </Button>
          </form>
        </Card>

        <div className="space-y-4">
          <Card>
            <SectionTitle
              title="AI Extractor"
              subtitle="RouterAI · ключ хранится только на сервере"
              action={
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={checkingAi}
                    onClick={() => void checkAi()}
                  >
                    Проверить
                  </Button>
                  <Button size="sm" variant="outline" loading={syncing} onClick={() => void syncNotes()}>
                    Разобрать заметки
                  </Button>
                </div>
              }
            />
            <dl className="space-y-2 text-[12.5px]">
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-[var(--muted)]">Модель</dt>
                <dd className="truncate text-right text-ink">{ai?.model ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-[var(--muted)]">Провайдер</dt>
                <dd className="truncate text-right text-ink">
                  {ai?.provider?.replace(/^https?:\/\//, "") ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">Статус</dt>
                <dd>
                  <Badge tone={ai?.enabled ? "success" : "neutral"}>
                    {ai?.enabled ? "включён" : "выключен"}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">Ключ API</dt>
                <dd>
                  <Badge tone={ai?.key_configured ? "success" : "warning"}>
                    {ai?.key_configured ? "настроен" : "локальный экстрактор"}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">Проверка заметок</dt>
                <dd>
                  {ai?.watcher_enabled ? (
                    <Badge tone="primary">каждые {ai.watcher_interval} с</Badge>
                  ) : (
                    <Badge tone="neutral">выключена</Badge>
                  )}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-[var(--muted)]">Таймаут / токены</dt>
                <dd className="text-ink">
                  {ai?.timeout_seconds ?? "—"} с / {ai?.max_tokens ?? "—"}
                </dd>
              </div>
            </dl>

            {aiHealth && (
              <div
                className={`mt-2.5 rounded-control px-2.5 py-2 text-[11.5px] ${
                  aiHealth.ok
                    ? "bg-[var(--success-soft)] text-[var(--success)]"
                    : "bg-[var(--danger-soft)] text-[var(--danger)]"
                }`}
              >
                {aiHealth.ok
                  ? `Провайдер отвечает (HTTP ${aiHealth.status ?? 200})`
                  : `Нет ответа: ${aiHealth.reason ?? "ошибка"}`}
              </div>
            )}

            {synced !== null && (
              <p className="mt-2 text-[11.5px] text-[var(--muted)]">
                Обработано заметок: {synced}
              </p>
            )}

            {!ai?.key_configured && (
              <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--muted)]">
                Без ключа работает детерминированный локальный экстрактор: даты, отрицания и условные действия
                обрабатываются по правилам, без сети.
              </p>
            )}
          </Card>

          <Card>
            <SectionTitle title="Передача клиента" subtitle="Права прежнего владельца отзываются немедленно" />
            {managers.length < 2 ? (
              <p className="text-[12.5px] text-[var(--muted)]">
                Для передачи нужно минимум два менеджера.
              </p>
            ) : (
              <div className="space-y-2">
                {clients.slice(0, 6).map((client) => (
                  <div key={client.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{client.name}</span>
                    <select
                      defaultValue=""
                      onChange={(e) => void transferClient(client.id, e.target.value)}
                      className="focus-ring h-8 rounded-lg border border-[var(--border-strong)] bg-surface px-2 text-[11.5px]"
                    >
                      <option value="">Передать →</option>
                      {managers.map((manager) => (
                        <option key={manager.id} value={manager.id}>
                          {manager.full_name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card>
        <SectionTitle title="Журнал аудита" subtitle="Действия без секретов и лишних персональных данных" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-[12px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-[0.04em] text-[var(--muted)]">
                <th className="py-1.5 pr-3 font-medium">Время</th>
                <th className="py-1.5 pr-3 font-medium">Сущность</th>
                <th className="py-1.5 pr-3 font-medium">Действие</th>
                <th className="py-1.5 pr-3 font-medium">IP</th>
                <th className="py-1.5 font-medium">Данные</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-[var(--muted)]">
                    {dateTimeRu(entry.created_at)}
                  </td>
                  <td className="py-1.5 pr-3 text-ink">{entry.entity}</td>
                  <td className="py-1.5 pr-3">
                    <Badge tone={entry.action.includes("failed") ? "danger" : "neutral"}>{entry.action}</Badge>
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--muted)]">{entry.ip ?? "—"}</td>
                  <td className="max-w-[240px] truncate py-1.5 text-[11.5px] text-[var(--muted)]">
                    {entry.metadata ? JSON.stringify(entry.metadata) : "—"}
                  </td>
                </tr>
              ))}
              {!audit.length && (
                <tr>
                  <td colSpan={5} className="py-3 text-center text-[var(--muted)]">
                    Записей нет
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-control bg-white/70 px-2.5 py-2">
      <p className="text-[10.5px] uppercase tracking-[0.03em] text-[var(--muted)]">{label}</p>
      <p className="mt-0.5 text-[16px] font-semibold text-ink">{value}</p>
    </div>
  );
}

function MiniKpi({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "primary" | "warning";
}) {
  const tones: Record<string, string> = {
    neutral: "text-ink",
    primary: "text-primary",
    warning: "text-[var(--warning)]",
  };
  return (
    <div className="rounded-card border border-[var(--border)] bg-surface p-3.5 shadow-soft">
      <p className="text-[11.5px] font-medium uppercase tracking-[0.04em] text-[var(--muted)]">{label}</p>
      <p className={`mt-1.5 text-[24px] font-semibold leading-none ${tones[tone]}`}>{value}</p>
    </div>
  );
}
