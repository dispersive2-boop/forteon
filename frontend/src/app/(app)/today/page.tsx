"use client";

/**
 * Главный экран «Сегодня» — рабочее место менеджера.
 *
 * Реализует DESIGN TASKS v2.1, §3 (п.19-31):
 *  19  компактные KPI без огромных пустых пространств
 *  20  под KPI — фильтры задач
 *  21  по умолчанию просроченные + сегодняшние открытые
 *  22  сортировка: просроченные -> критичные -> по времени (на сервере)
 *  23  в задаче: checkbox, название, клиент, дата/время, приоритет
 *  24  клик по строке открывает подробности справа
 *  25  checkbox закрывает задачу с возможностью отменить (undo)
 *  26  в контексте: «Перенести», «Открыть клиента», «Исходная заметка»
 *  27  без времени показываем дату, без выдуманного «09:00»
 *  28  просрочка — тонкая полоса, не красная заливка строки
 *  29  пустое состояние с кнопкой «Добавить заметку»
 *  30  счётчики обновляются без перезагрузки страницы
 *  31  кнопка «Показать выполненные», по умолчанию скрыты
 *
 * Плюс §1 (п.4-8): список ~65%, контекстная панель ~35% минимум 300px,
 * при узком экране панель уходит в drawer.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuth } from "@/components/AuthProvider";
import { IconPlus } from "@/components/icons";
import { TaskChatBody, useTaskChat } from "@/components/TaskChat";
import {
  Button,
  ButtonLink,
  Card,
  DoneTaskRow,
  EmptyState,
  ErrorState,
  Modal,
  ReviewChip,
  SectionTitle,
  Skeleton,
  Stat,
  Tabs,
  TaskItem,
  priorityLabel,
} from "@/components/ui";
import { api, TodayPayload, Task } from "@/lib/api";
import { dateRu, dateTimeRu, money, relativeDay, TASK_TYPE_LABELS } from "@/lib/format";

type FilterKey = "all" | "payment" | "call" | "document" | "delivery" | "review" | "done";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "payment", label: "Оплаты" },
  { key: "call", label: "Звонки" },
  { key: "document", label: "Документы" },
  { key: "delivery", label: "Поставки" },
  { key: "review", label: "Уточнить" },
  { key: "done", label: "Выполненные" },
];

/** Перенос на N дней вперёд — быстрые кнопки в диалоге (п.26, п.74). */
const SHIFTS = [
  { days: 1, label: "Завтра" },
  { days: 3, label: "+3 дня" },
  { days: 7, label: "Через неделю" },
];

function isoDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function TodayPage() {
  const { user } = useAuth();
  const [data, setData] = useState<TodayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [undo, setUndo] = useState<{ task: Task } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chat = useTaskChat();

  const load = useCallback(async () => {
    setError(null);
    try {
      const payload = await api<TodayPayload>("/tasks/today");
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить план на день");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  /*
    Пункт 7: шторка с подробностями задачи закрывается по Esc.
    На планшете с клавиатурой и при работе в браузере это ожидаемое
    поведение; раньше помогала только кнопка «Закрыть» и тап по фону.
  */
  useEffect(() => {
    if (!sheetOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [sheetOpen]);

  const items = data?.items ?? [];
  const doneItems = data?.done ?? [];

  /** Фильтрация на клиенте: сервер уже отдал отсортированный список (п.22). */
  const visible = useMemo(() => {
    if (filter === "done") return [];
    if (filter === "all") return items;
    if (filter === "review") return items.filter((t) => t.needs_review);
    return items.filter((t) => t.type === filter);
  }, [items, filter]);

  const selected = useMemo(
    () => [...items, ...doneItems].find((t) => t.id === selectedId) ?? null,
    [items, doneItems, selectedId],
  );

  const counts = useMemo(() => {
    const acc: Record<FilterKey, number> = {
      all: items.length,
      payment: 0,
      call: 0,
      document: 0,
      delivery: 0,
      review: 0,
      done: doneItems.length,
    };
    for (const t of items) {
      if (t.type === "payment") acc.payment += 1;
      if (t.type === "call") acc.call += 1;
      if (t.type === "document") acc.document += 1;
      if (t.type === "delivery") acc.delivery += 1;
      if (t.needs_review) acc.review += 1;
    }
    return acc;
  }, [items, doneItems]);

  /** Пункт 25 и 30: закрытие без перезагрузки + отмена действия. */
  async function complete(task: Task) {
    setBusyId(task.id);
    try {
      await api(`/tasks/${task.id}/complete`, { method: "POST", body: { result_note: null } });
      if (undoTimer.current) clearTimeout(undoTimer.current);
      setUndo({ task });
      undoTimer.current = setTimeout(() => setUndo(null), 8000);
      if (selectedId === task.id) setSelectedId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось закрыть задачу");
    } finally {
      setBusyId(null);
    }
  }

  async function cancelUndo() {
    if (!undo) return;
    const { task } = undo;
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    try {
      await api(`/tasks/${task.id}/reopen`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось вернуть задачу");
    }
  }

  async function reopen(taskId: string) {
    setBusyId(taskId);
    try {
      await api(`/tasks/${taskId}/reopen`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось вернуть задачу");
    } finally {
      setBusyId(null);
    }
  }

  async function reschedule(taskId: string, dateValue: string) {
    setBusyId(taskId);
    try {
      await api(`/tasks/${taskId}/reschedule`, {
        method: "POST",
        body: { due_date: dateValue, due_at: null, reason: "Перенос с экрана «Сегодня»" },
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось перенести задачу");
    } finally {
      setBusyId(null);
    }
  }

  const todayLabel = new Date().toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const firstName = user?.full_name?.split(" ")[0] ?? "";

  if (error && !data) {
    return (
      <div className="mx-auto max-w-[1240px]">
        <ErrorState description={error} onRetry={() => { setLoading(true); void load(); }} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px]">
      {/*
        Заголовок страницы. Кнопку «Новая заметка» здесь не дублируем:
        она уже есть в топбаре (п.3). Две одинаковые кнопки на одном
        экране — избыточность (п.11), проверено скриншотом.
      */}
      <header className="mb-4">
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.028em] text-ink">
          Сегодня
        </h1>
        <p className="mt-1 text-[13px] capitalize text-[var(--muted)]">
          {todayLabel}
          {firstName ? ` · ${firstName}` : ""}
        </p>
      </header>

      {/*
        Пункт 19: компактные KPI. Пункт 20: они же работают фильтрами.
        Сетка 3x2 на мобильном и строка на десктопе — иначе пятая плашка
        растягивалась на всю ширину (видно на скриншоте 390px).
      */}
      <div className="mb-4 grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[62px] flex-1 rounded-control sm:w-[120px] sm:flex-none" />)
        ) : (
          <>
            <Stat
              label="На сегодня"
              value={data?.counters.today ?? 0}
              tone="primary"
              active={filter === "all"}
              onClick={() => setFilter("all")}
            />
            <Stat
              label="Просрочено"
              value={data?.counters.overdue ?? 0}
              tone={(data?.counters.overdue ?? 0) > 0 ? "danger" : "neutral"}
            />
            <Stat
              label="Оплаты"
              value={data?.counters.payments ?? 0}
              tone={(data?.counters.payments ?? 0) > 0 ? "warning" : "neutral"}
              active={filter === "payment"}
              onClick={() => setFilter("payment")}
            />
            <Stat
              label="Уточнить"
              value={data?.counters.review ?? 0}
              tone={(data?.counters.review ?? 0) > 0 ? "warning" : "neutral"}
              active={filter === "review"}
              onClick={() => setFilter("review")}
            />
            <Stat
              label="Выполнено"
              value={data?.counters.done_today ?? 0}
              tone="success"
              active={filter === "done"}
              onClick={() => setFilter("done")}
            />
          </>
        )}
      </div>

      {!loading && items.length > 0 && (data?.counters.overdue ?? 0) > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-[var(--border)] bg-surface px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Начните с просроченной задачи</p>
            <p className="break-words text-sm text-[var(--muted)]">{items[0].title}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => {
            setSelectedId(items[0].id);
            setSheetOpen(true);
          }}>Открыть задачу</Button>
        </div>
      )}

      {error && data && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-control border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      )}

      {/* Пункт 4-6: список ~65%, контекст ~35% (мин. 300px) */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(300px,1fr)]">
        {/* ---------------------------------------------------- список задач */}
        <Card padded={false} className="overflow-hidden">
          <div className="border-b border-[var(--border)] px-4 pb-3 pt-3.5">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-[16.5px] font-semibold tracking-[-0.015em] text-ink">
                План на день
              </h2>
              <span className="shrink-0 text-[12.5px] text-[var(--muted)]">
                {filter === "done" ? `${doneItems.length} закрыто` : `${visible.length} задач`}
              </span>
            </div>
            <Tabs items={FILTERS.map((f) => ({ ...f, count: counts[f.key] }))} value={filter} onChange={setFilter} />
          </div>

          <div key={filter} className={`min-h-[280px] px-2 py-2 ${loading ? "" : "forteon-tab-panel"}`}>
            {loading ? (
              <div className="space-y-1.5 px-2 py-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-[62px] rounded-control" />
                ))}
              </div>
            ) : filter === "done" ? (
              doneItems.length ? (
                <div className="space-y-0.5">
                  {doneItems.map((task) => (
                    <DoneTaskRow
                      key={task.id}
                      task={task}
                      onReopen={busyId === task.id ? undefined : () => void reopen(task.id)}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="Сегодня ещё ничего не закрыто"
                  description="Закрытые задачи появятся здесь с временем завершения."
                />
              )
            ) : visible.length ? (
              <div className="space-y-0.5">
                {visible.map((task) => (
                  <TaskItem
                    key={task.id}
                    task={task}
                    active={selectedId === task.id}
                    busy={busyId === task.id}
                    onSelect={() => {
                      setSelectedId(task.id);
                      setSheetOpen(true);
                    }}
                    onComplete={() => void complete(task)}
                    onReschedule={() => {
                      setSelectedId(task.id);
                      setSheetOpen(true);
                    }}
                  />
                ))}
              </div>
            ) : (
              /* Пункт 29: понятное пустое состояние + кнопка «Добавить заметку» */
              <EmptyState
                title={
                  filter === "all"
                    ? "На сегодня задач со сроком нет"
                    : "В этом фильтре задач нет"
                }
                description={
                  filter === "all"
                    ? "Задачи появляются из заметок: AI извлекает срок и тип. Задач без срока — в блоке «Уточнить»."
                    : "Выберите другой фильтр или добавьте заметку — AI предложит задачи."
                }
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <ButtonLink href="/notes" size="sm">
                      Добавить заметку
                    </ButtonLink>
                    {filter === "all" ? (
                      <ButtonLink href="/planner" variant="outline" size="sm">
                        Открыть планировщик
                      </ButtonLink>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => setFilter("all")}>
                        Показать все
                      </Button>
                    )}
                  </div>
                }
              />
            )}
          </div>

          {/* Пункт 31: переключатель выполненных */}
          {!loading && doneItems.length > 0 && filter !== "done" && (
            <div className="border-t border-[var(--border)] px-3 py-2">
              <button
                type="button"
                onClick={() => setFilter("done")}
                /* Пункт 11: зона нажатия не меньше 44px на телефоне. */
                className="focus-ring inline-flex min-h-[44px] items-center rounded-lg px-2 py-1.5 text-[13px] font-medium text-primary transition-colors hover:bg-[var(--primary-soft)] sm:min-h-0"
              >
                Показать выполненные ({doneItems.length})
              </button>
            </div>
          )}
        </Card>

        {/* ------------------------------------------- контекстная панель (п.6) */}
        <div className="space-y-3">
          <ContextPanel
            task={selected}
            onReschedule={reschedule}
            onClose={() => setSelectedId(null)}
            busy={busyId === selected?.id}
            onOpenChat={(id) => void chat.open(id)}
          />

          {/* Уточнения без срока — часть работы, но не в основном списке */}
          {!loading && (data?.counters.review ?? 0) > 0 && (
            <Card>
              <SectionTitle
                title="Требуют уточнения"
                subtitle="AI не определил срок — решите, когда это сделать"
              />
              <Link
                href="/planner"
                className="focus-ring inline-flex min-h-[44px] items-center gap-1.5 rounded-lg text-[13.5px] font-medium text-primary hover:underline"
              >
                Открыть {data?.counters.review} задач <span aria-hidden>→</span>
              </Link>
            </Card>
          )}
        </div>
      </div>

      {/* ------------------------------------------------- мобильный drawer (п.8) */}
      {sheetOpen && selected && (
        <div className="fixed inset-0 z-[55] xl:hidden">
          <button
            type="button"
            className="forteon-overlay absolute inset-0 bg-[#0b1220]/45"
            onClick={() => setSheetOpen(false)}
            aria-label="Закрыть подробности"
          />
          <div className="forteon-floating forteon-sheet forteon-task-sheet absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto overscroll-contain bg-surface p-4">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--border-strong)]" />
            <TaskContextContent
              task={selected}
              onReschedule={reschedule}
              onClose={() => setSheetOpen(false)}
              busy={busyId === selected.id}
              onOpenChat={(id) => void chat.open(id)}
            />
          </div>
        </div>
      )}

      {/* Задача как чат — из «Сегодня» тоже */}
      <Modal
        open={Boolean(chat.taskId)}
        title={chat.chat?.task.title ?? "Задача"}
        onClose={chat.close}
      >
        <TaskChatBody
          chat={chat.chat}
          loading={chat.loading}
          error={chat.error}
          draft={chat.draft}
          sending={chat.sending}
          onDraft={chat.setDraft}
          onRetry={chat.taskId ? () => void chat.open(chat.taskId!) : undefined}
          onHistory
          onSend={async () => {
            const text = chat.draft.trim();
            if (!text || !chat.chat) return;
            chat.setSending(true);
            chat.setError(null);
            try {
              await api(`/clients/${chat.chat.client.id}/notes`, {
                method: "POST",
                body: { body: text, run_ai: true, source_type: "text" },
              });
              chat.setDraft("");
              await chat.reload();
              await load();
            } catch (err) {
              chat.setError(
                err instanceof Error
                  ? `Заметка не сохранена: ${err.message}. Текст остался в поле.`
                  : "Заметка не сохранена.",
              );
            } finally {
              chat.setSending(false);
            }
          }}
        />
      </Modal>

      {/* Пункт 25: отмена закрытия (undo) */}
      {undo && (
        <div className="forteon-floating forteon-glass-inverse fixed bottom-20 left-1/2 z-50 flex w-[min(94vw,420px)] -translate-x-1/2 items-center gap-3 px-4 py-3 text-white lg:bottom-6">
          <span className="min-w-0 flex-1 truncate text-[13.5px]">
            Задача закрыта: {undo.task.title}
          </span>
          <button
            type="button"
            onClick={() => void cancelUndo()}
            className="focus-ring shrink-0 rounded-lg px-2 py-1 text-[13px] font-semibold text-[#7DD3FC] hover:bg-white/10"
          >
            Отменить
          </button>
        </div>
      )}
    </div>
  );
}

/** Правая панель с подробностями выбранной задачи (п.6, п.24, п.26). */
function ContextPanel({
  task,
  onReschedule,
  onClose,
  busy,
  onOpenChat,
}: {
  task: Task | null;
  onReschedule: (id: string, date: string) => void;
  onClose: () => void;
  busy: boolean;
  onOpenChat: (id: string) => void;
}) {
  return (
    <Card className="sticky top-[80px] hidden xl:block">
      {task ? (
        <TaskContextContent
          task={task}
          onReschedule={onReschedule}
          onClose={onClose}
          busy={busy}
          onOpenChat={onOpenChat}
        />
      ) : (
        <div className="py-6 text-center">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-[#f1f4f9] text-[var(--muted)]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01" />
            </svg>
          </div>
          <p className="text-[14px] font-medium text-ink">Выберите задачу</p>
          <p className="mx-auto mt-1 max-w-[240px] text-[12.5px] leading-relaxed text-[var(--muted)]">
            Здесь появятся клиент, срок, тип и ссылки на исходную заметку.
          </p>
        </div>
      )}
    </Card>
  );
}

function TaskContextContent({
  task,
  onReschedule,
  onClose,
  busy,
  onOpenChat,
}: {
  task: Task;
  onReschedule: (id: string, date: string) => void;
  onClose: () => void;
  busy: boolean;
  onOpenChat: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-[15.5px] font-semibold leading-snug text-ink">{task.title}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Закрыть"
          className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[var(--muted)] hover:bg-[#f1f4f9]"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <dl className="space-y-2 text-[13px]">
        <Row label="Клиент">
          <Link
            href={`/clients/${task.client_id}`}
            className="focus-ring font-medium text-primary hover:underline"
          >
            {task.client_name ?? "Открыть клиента"}
          </Link>
        </Row>
        <Row label="Срок">{relativeDay(task.due_date)}</Row>
        {task.due_at && <Row label="Время">{dateTimeRu(task.due_at)}</Row>}
        <Row label="Дата">{task.due_date ? dateRu(task.due_date) : "не указана"}</Row>
        <Row label="Тип">{TASK_TYPE_LABELS[task.type] ?? task.type}</Row>
        <Row label="Приоритет">{priorityLabel(task.priority)}</Row>
        <Row label="Источник">
          {task.origin === "ai" ? "AI из заметки" : task.origin === "import" ? "Импорт отчёта" : "Создана вручную"}
        </Row>
      </dl>

      {task.needs_review && (
        <div className="mt-3 rounded-control bg-[var(--warning-soft)] px-3 py-2">
          <ReviewChip reason={task.review_reason} />
          <p className="mt-1 text-[12px] leading-snug text-[#8a5a12]">
            {task.review_reason || "Срок не определён — задайте дату."}
          </p>
        </div>
      )}

      {/* Пункт 26: «Перенести», «Открыть клиента», «Исходная заметка» */}
      <div className="mt-4 space-y-2">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]">
          Перенести
        </p>
        <div className="flex flex-wrap gap-1.5">
          {SHIFTS.map((shift) => (
            <button
              key={shift.days}
              type="button"
              disabled={busy}
              onClick={() => onReschedule(task.id, isoDate(shift.days))}
              className="focus-ring h-9 rounded-lg border border-[var(--border-strong)] px-2.5 text-[12.5px] font-medium text-ink transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {shift.label}
            </button>
          ))}
        </div>
        <input
          type="date"
          aria-label="Своя дата"
          defaultValue={task.due_date ?? ""}
          onChange={(event) => {
            if (event.target.value) onReschedule(task.id, event.target.value);
          }}
          className="focus-ring h-9 w-full rounded-lg border border-[var(--border-strong)] px-2.5 text-[12.5px] text-ink"
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenChat(task.id)}
        >
          Чат по задаче
        </Button>
        <ButtonLink href={`/clients/${task.client_id}`} variant="outline" size="sm">
          Открыть клиента
        </ButtonLink>
        {task.source_note_id ? (
          <ButtonLink href={`/clients/${task.client_id}?tab=notes`} variant="subtle" size="sm">
            Исходная заметка
          </ButtonLink>
        ) : (
          <span className="inline-flex items-center rounded-lg bg-[#f1f4f9] px-2.5 py-1.5 text-[12px] text-[var(--muted)]">
            Создана вручную
          </span>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[var(--muted)]">{label}</dt>
      <dd className="min-w-0 truncate text-right text-ink">{children}</dd>
    </div>
  );
}
