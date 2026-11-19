"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  Skeleton,
  TaskRow,
} from "@/components/ui";
import { api, Planner, Task } from "@/lib/api";
import { dateRu, relativeDay } from "@/lib/format";

const FILTERS = [
  { key: "all", label: "Все" },
  { key: "overdue", label: "Просрочено" },
  { key: "today", label: "Сегодня" },
  { key: "week", label: "Неделя" },
  { key: "later", label: "Позже" },
  { key: "needs_review", label: "Уточнить" },
  { key: "done", label: "Закрытые" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];

export default function PlannerPage() {
  const [planner, setPlanner] = useState<Planner | null>(null);
  const [done, setDone] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [open, closed] = await Promise.all([
        api<Planner>("/planner"),
        api<{ items: Task[] }>("/tasks?status=done&limit=60"),
      ]);
      setPlanner(open);
      setDone(closed.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки планировщика");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function complete(taskId: string) {
    setBusy(taskId);
    try {
      await api(`/tasks/${taskId}/complete`, { method: "POST", body: {} });
      await load();
    } finally {
      setBusy(null);
    }
  }

  /** Вернуть закрытую задачу в работу. */
  async function reopen(taskId: string) {
    setBusy(taskId);
    try {
      await api(`/tasks/${taskId}/reopen`, { method: "POST", body: {} });
      await load();
    } finally {
      setBusy(null);
    }
  }

  const groups = useMemo(() => {
    if (!planner) return [];
    const all: {
      key: FilterKey;
      title: string;
      subtitle: string;
      tasks: Task[];
      tone: "danger" | "primary" | "neutral" | "warning" | "success";
    }[] = [
      { key: "overdue", title: "Просрочено", subtitle: "Срок истёк", tasks: planner.overdue, tone: "danger" },
      { key: "today", title: "Сегодня", subtitle: dateRu(planner.date_from), tasks: planner.today, tone: "primary" },
      {
        key: "week",
        title: "Ближайшие 7 дней",
        subtitle: `${dateRu(planner.date_from)} — ${dateRu(planner.date_to)}`,
        tasks: planner.week,
        tone: "neutral",
      },
      { key: "later", title: "Позже", subtitle: "Дальние сроки и без даты", tasks: planner.later, tone: "neutral" },
      {
        key: "needs_review",
        title: "Требуют уточнения",
        subtitle: "Срок и ответственный",
        tasks: planner.needs_review,
        tone: "warning",
      },
      {
        key: "done",
        title: "Закрытые",
        subtitle: "Можно вернуть в работу",
        tasks: done,
        tone: "success",
      },
    ];
    if (filter === "all") {
      // В общем списке закрытые не показываем — только по отдельной вкладке
      return all.filter((g) => g.key !== "done");
    }
    return all.filter((g) => g.key === filter);
  }, [planner, filter, done]);

  const total = planner
    ? planner.overdue.length + planner.today.length + planner.week.length + planner.later.length + planner.needs_review.length
    : 0;

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[23px] font-semibold tracking-[-0.025em] text-ink">Планировщик</h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            День, неделя, месяц и дальние сроки. Всего открытых задач: {total}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} loading={loading}>
            Обновить
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((item) => {
          const active = filter === item.key;
          const count =
            item.key === "all"
              ? total
              : planner
                ? planner[item.key as keyof Planner] instanceof Array
                  ? (planner[item.key as keyof Planner] as Task[]).length
                  : 0
                : 0;
          return (
            <button
              key={item.key}
              onClick={() => setFilter(item.key)}
              className={`focus-ring inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors ${
                active
                  ? "border-primary bg-primary text-white"
                  : "border-[var(--border-strong)] bg-surface text-[var(--muted)] hover:border-primary hover:text-primary"
              }`}
            >
              {item.label}
              <span className={active ? "text-white/85" : "text-[var(--muted)]"}>{count}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-card" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((group) => (
            <Card key={group.key}>
              <SectionTitle
                title={group.title}
                subtitle={group.subtitle}
                action={<Badge tone={group.tone}>{group.tasks.length}</Badge>}
              />
              {group.tasks.length ? (
                <div className="-mx-1 max-h-[420px] overflow-y-auto">
                  {group.tasks.map((task) =>
                    group.key === "done" ? (
                      <DoneRow
                        key={task.id}
                        task={task}
                        busy={busy === task.id}
                        onReopen={() => void reopen(task.id)}
                      />
                    ) : (
                      <TaskRow
                        key={task.id}
                        task={task}
                        onComplete={busy === task.id ? undefined : complete}
                      />
                    ),
                  )}
                </div>
              ) : (
                <EmptyState
                  title="Пусто"
                  description={
                    group.key === "done"
                      ? "Закрытых задач пока нет."
                      : "В этой группе нет задач."
                  }
                />
              )}
            </Card>
          ))}
        </div>
      )}

      {!loading && planner && groups.every((g) => g.tasks.length === 0) && (
        <Card>
          <EmptyState
            title="Задач нет"
            description="Откройте карточку клиента и добавьте заметку — AI предложит задачи с датами."
          />
        </Card>
      )}
    </div>
  );
}

/** Строка закрытой задачи с кнопкой возврата в работу. */
function DoneRow({
  task,
  busy,
  onReopen,
}: {
  task: Task;
  busy: boolean;
  onReopen: () => void;
}) {
  const when = task.completed_at ? dateRu(task.completed_at) : "без даты";
  return (
    <div className="group flex items-start gap-3 rounded-control px-2.5 py-2.5 transition-colors hover:bg-[#f7f9fc]">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--success-soft)] text-[var(--success)]">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14.5px] leading-snug text-[var(--muted)] line-through">
          {task.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-[var(--muted)]">
          {task.client_name && <span className="truncate font-medium">{task.client_name}</span>}
          <span>закрыта {when}</span>
        </div>
      </div>
      <button
        onClick={onReopen}
        disabled={busy}
        title="Вернуть в работу"
        className="focus-ring mt-0.5 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-strong)] px-2.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
        </svg>
        Вернуть
      </button>
    </div>
  );
}
