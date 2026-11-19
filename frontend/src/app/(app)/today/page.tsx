"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/components/AuthProvider";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  KpiCard,
  MoneyValue,
  ProgressBar,
  SectionTitle,
  Skeleton,
  TaskRow,
} from "@/components/ui";
import { api, API_ROOT, FinancialSummary, Planner, PlannerSummary, Task } from "@/lib/api";
import { dateRu } from "@/lib/format";

type Health = {
  status: string;
  ai: {
    provider: string;
    model: string;
    api_key: boolean;
    enabled: boolean;
    watcher: boolean;
    watcher_interval: number;
  };
};

export default function TodayPage() {
  const { user } = useAuth();
  const [planner, setPlanner] = useState<Planner | null>(null);
  const [summary, setSummary] = useState<PlannerSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [plannerData, summaryData] = await Promise.all([
        api<Planner>("/planner"),
        api<PlannerSummary>("/planner/summary"),
      ]);
      setPlanner(plannerData);
      setSummary(summaryData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить план");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // В production frontend и API живут на одном origin (Caddy), поэтому /health.
    // API_ROOT уже учитывает, открыта ли страница с localhost или с домена.
    const healthUrl = `${API_ROOT}/health`;
    fetch(healthUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setHealth(data))
      .catch(() => setHealth(null));
  }, [load]);

  async function complete(taskId: string) {
    setBusy(taskId);
    try {
      await api(`/tasks/${taskId}/complete`, { method: "POST", body: { result_note: null } });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const today = new Date();
  const greeting =
    today.getHours() < 12 ? "Доброе утро" : today.getHours() < 18 ? "Добрый день" : "Добрый вечер";

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
            {today.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
          </p>
          <h1 className="mt-1 text-[23px] font-semibold leading-tight tracking-[-0.025em] text-ink">
            {greeting}
            {user ? `, ${user.full_name.split(" ")[0]}` : ""}
          </h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Просроченное, платежи и задачи на сегодня — в одном списке.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/notes" variant="outline">
            Новая заметка
          </ButtonLink>
          <ButtonLink href="/reports">Сформировать отчёт</ButtonLink>
        </div>
      </header>

      {error && (
        <div className="rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[86px] rounded-card" />)
        ) : (
          <>
            <KpiCard label="Сегодня" value={summary?.today ?? 0} hint="задачи со сроком сегодня" tone="primary" href="/planner" />
            <KpiCard
              label="Просрочено"
              value={summary?.overdue ?? 0}
              hint="требуют немедленного действия"
              tone={summary && summary.overdue > 0 ? "danger" : "neutral"}
              href="/planner"
            />
            <KpiCard label="Ближайшая неделя" value={summary?.week ?? 0} hint="до конца 7 дней" />
            <KpiCard
              label="Уточнить"
              value={summary?.needs_review ?? 0}
              hint="срок не определён"
              tone={summary && summary.needs_review > 0 ? "warning" : "neutral"}
            />
          </>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <div className="space-y-4">
          <Card>
            <SectionTitle
              title="Просрочено"
              subtitle="Задачи с истёкшим сроком и без отметки о выполнении"
              action={<Badge tone={planner?.overdue.length ? "danger" : "success"}>{planner?.overdue.length ?? 0}</Badge>}
            />
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-11" />
                ))}
              </div>
            ) : planner?.overdue.length ? (
              <div className="-mx-1">
                {planner.overdue.map((task) => (
                  <TaskRow key={task.id} task={task} onComplete={busy === task.id ? undefined : complete} />
                ))}
              </div>
            ) : (
              <EmptyState title="Просрочек нет" description="Отличный результат — все сроки под контролем." />
            )}
          </Card>

          <Card>
            <SectionTitle
              title="Сегодня"
              subtitle="План на текущий день"
              action={<Badge tone="primary">{planner?.today.length ?? 0}</Badge>}
            />
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-11" />
                ))}
              </div>
            ) : planner?.today.length ? (
              <div className="-mx-1">
                {planner.today.map((task) => (
                  <TaskRow key={task.id} task={task} onComplete={busy === task.id ? undefined : complete} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="На сегодня задач нет"
                description="Добавьте заметку в карточке клиента — AI предложит задачи."
                action={
                  <ButtonLink href="/notes" variant="subtle" size="sm">
                    Добавить заметку
                  </ButtonLink>
                }
              />
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <SectionTitle title="Требуют уточнения" subtitle="Без выдуманных дедлайнов" />
            {loading ? (
              <Skeleton className="h-24" />
            ) : planner?.needs_review.length ? (
              <>
                <div className="-mx-1 max-h-[268px] overflow-y-auto">
                  {planner.needs_review.slice(0, 8).map((task) => (
                    <TaskRow key={task.id} task={task} compact />
                  ))}
                </div>
                {planner.needs_review.length > 8 && (
                  <Link
                    href="/planner"
                    className="mt-2 inline-block text-[12.5px] font-medium text-primary hover:underline"
                  >
                    Ещё {planner.needs_review.length - 8} задач →
                  </Link>
                )}
              </>
            ) : (
              <p className="text-[13px] text-[var(--muted)]">Все задачи имеют определённый срок.</p>
            )}
          </Card>

          <Card>
            <SectionTitle title="Состояние системы" subtitle="Диагностика MVP" />
            <dl className="space-y-2 text-[12.5px]">
              <div className="flex items-center justify-between">
                <dt className="text-[var(--muted)]">API</dt>
                <dd>
                  {health ? <Badge tone="success">доступен</Badge> : <Badge tone="warning">нет данных</Badge>}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="shrink-0 text-[var(--muted)]">AI-модель</dt>
                <dd className="truncate text-right text-ink">{health?.ai.model ?? "—"}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[var(--muted)]">Провайдер</dt>
                <dd className="truncate pl-3 text-right text-ink">
                  {health?.ai.provider?.replace(/^https?:\/\//, "") ?? "—"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[var(--muted)]">Ключ API</dt>
                <dd>
                  {health?.ai.api_key ? (
                    <Badge tone="success">настроен</Badge>
                  ) : (
                    <Badge tone="warning">локальный экстрактор</Badge>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[var(--muted)]">Проверка заметок</dt>
                <dd>
                  {health?.ai.watcher ? (
                    <Badge tone="primary">каждые {health.ai.watcher_interval} с</Badge>
                  ) : (
                    <Badge tone="neutral">выключена</Badge>
                  )}
                </dd>
              </div>
            </dl>
          </Card>

          <Card>
            <SectionTitle title="Завершено сегодня" subtitle="Контроль результата" />
            <p className="text-[26px] font-semibold leading-none text-[var(--success)]">
              {summary?.completed_today ?? 0}
            </p>
            <div className="mt-2.5">
              <ProgressBar
                value={
                  summary && summary.today + summary.completed_today > 0
                    ? (summary.completed_today / (summary.today + summary.completed_today)) * 100
                    : 0
                }
                tone="success"
              />
            </div>
            <p className="mt-2 text-[11.5px] text-[var(--muted)]">
              Доля закрытых от общего числа задач на сегодня
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
