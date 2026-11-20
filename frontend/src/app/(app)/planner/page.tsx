"use client";

/**
 * Планировщик — §6 (65–78).
 *
 * Четыре режима: День / Неделя / Месяц / Год. Переключение не перезагружает
 * страницу, период хранится в URL (?view=month&date=2026-11-19), поэтому
 * ссылку на «вот этот месяц» можно отправить коллеге (п.118).
 *
 * Данные берём одним запросом /tasks?status=all и группируем на клиенте:
 * так в дне видно и задачи со временем, и «без времени», и просрочку —
 * без трёх отдельных запросов и без расхождений между ними.
 *
 * Drag-and-drop не обязателен (п.76): срок меняется через диалог
 * «Перенести», который работает и на телефоне.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  ReviewChip,
  Skeleton,
  inputClass,
  textareaClass,
} from "@/components/ui";
import { api, Task, TaskChat } from "@/lib/api";
import {
  PRIORITY_LABELS,
  TASK_TYPE_LABELS,
  dateRu,
  dateTimeRu,
  relativeDay,
} from "@/lib/format";

/* ------------------------------------------------------------------ утилиты */

type View = "day" | "week" | "month" | "year";

const VIEWS: { key: View; label: string }[] = [
  { key: "day", label: "День" },
  { key: "week", label: "Неделя" },
  { key: "month", label: "Месяц" },
  { key: "year", label: "Год" },
];

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

/** Локальная дата → «2026-11-19». Без toISOString: он даёт сдвиг на UTC. */
function toISO(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fromISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function todayISO(): string {
  return toISO(new Date());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Понедельник недели, в которую попадает дата. */
function startOfWeek(date: Date): Date {
  const dow = (date.getDay() + 6) % 7;
  return addDays(date, -dow);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** Время из due_at (в БД хранится наивный UTC). */
function timeOf(iso: string | null): string | null {
  if (!iso) return null;
  const stamp = iso.endsWith("Z") ? iso : `${iso}Z`;
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/** Диапазон, который показывает текущий режим. */
function rangeOf(view: View, anchor: Date): { from: string; to: string; label: string } {
  if (view === "day") {
    return { from: toISO(anchor), to: toISO(anchor), label: dateRu(toISO(anchor)) };
  }
  if (view === "week") {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    return {
      from: toISO(start),
      to: toISO(end),
      label: `${start.getDate()}–${end.getDate()} ${MONTHS[end.getMonth()].toLowerCase()}`,
    };
  }
  if (view === "month") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth(), daysInMonth(anchor.getFullYear(), anchor.getMonth()));
    return {
      from: toISO(first),
      to: toISO(last),
      label: `${MONTHS[anchor.getMonth()]} ${anchor.getFullYear()}`,
    };
  }
  const first = new Date(anchor.getFullYear(), 0, 1);
  const last = new Date(anchor.getFullYear(), 11, 31);
  return { from: toISO(first), to: toISO(last), label: String(anchor.getFullYear()) };
}

function shiftPeriod(view: View, anchor: Date, direction: number): Date {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, direction * 7);
  if (view === "month") {
    return new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
  }
  return new Date(anchor.getFullYear() + direction, 0, 1);
}

/* ------------------------------------------------------------------ страница */

export default function PlannerPage() {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<string>(todayISO());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);

  const [reschedule, setReschedule] = useState<Task | null>(null);
  const [newDate, setNewDate] = useState<string>("");
  const [savingDate, setSavingDate] = useState(false);

  /*
    «Задача как чат» (запрос пользователя): нажал на задачу — видишь всю
    переписку-заметки по этому клиенту и можешь сразу добавить новую,
    не уходя на экран заметок и не теряя контекст задачи.
  */
  const [chatTaskId, setChatTaskId] = useState<string | null>(null);
  const [chat, setChat] = useState<TaskChat | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatSending, setChatSending] = useState(false);

  const urlRead = useRef(false);

  /* --------------------------------------------------- состояние в URL */
  useEffect(() => {
    if (urlRead.current) return;
    urlRead.current = true;
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const searchView = params.get("view") as View | null;
    const searchDate = params.get("date");
    if (searchView && VIEWS.some((v) => v.key === searchView)) setView(searchView);
    if (searchDate && /^\d{4}-\d{2}-\d{2}$/.test(searchDate)) setAnchor(searchDate);
  }, []);

  useEffect(() => {
    if (!urlRead.current || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    url.searchParams.set("date", anchor);
    window.history.replaceState(null, "", url.toString());
  }, [view, anchor]);

  /* ------------------------------------------------------------- данные */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      // status=all: нужны и закрытые (п.72), и просрочка, и «без даты»
      const data = await api<{ items: Task[] }>("/tasks?status=all&limit=500");
      setTasks(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить задачи");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // /clients/picker ограничен 50 (для поиска), здесь нужен полный
        // список для выпадающего фильтра — берём /clients.
        const data = await api<{ items: { id: string; name: string }[] }>(
          "/clients?limit=200",
        );
        if (!cancelled) setClients(data.items);
      } catch {
        /* фильтр по клиенту просто не появится */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------------------------------------ действия */
  async function complete(taskId: string) {
    setBusy(taskId);
    try {
      await api(`/tasks/${taskId}/complete`, { method: "POST", body: { result_note: null } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось закрыть задачу");
    } finally {
      setBusy(null);
    }
  }

  async function reopen(taskId: string) {
    setBusy(taskId);
    try {
      await api(`/tasks/${taskId}/reopen`, { method: "POST", body: {} });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось вернуть задачу");
    } finally {
      setBusy(null);
    }
  }

  function openReschedule(task: Task) {
    setReschedule(task);
    setNewDate(task.due_date ?? toISO(fromDate(task)));
  }

  /**
   * п.23: принять / изменить / отклонить предложенную задачу.
   *
   * В планировщике задача с needs_review раньше показывала только чип
   * «Уточнить срок» и кнопку «Перенести» — то есть требовала назначить срок,
   * но не позволяла сказать «это не задача». Здесь то же решение, что в
   * заметках: accept снимает уточнение, edit — задаёт срок/формулировку,
   * reject — убирает задачу из списка.
   */
  /* ------------------------------------------------- задача как чат */
  const openChat = useCallback(async (taskId: string) => {
    setChatTaskId(taskId);
    setChatLoading(true);
    setChatError(null);
    setChat(null);
    setChatDraft("");
    try {
      const data = await api<TaskChat>(`/tasks/${taskId}/chat?limit=40`);
      setChat(data);
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Не удалось открыть задачу");
    } finally {
      setChatLoading(false);
    }
  }, []);

  async function sendChatNote() {
    const text = chatDraft.trim();
    if (!text || !chat) return;
    setChatSending(true);
    setChatError(null);
    try {
      // Заметка создаётся как обычная: AI разберёт её и, если появится
      // новое действие, задача добавится в план. Контекст задачи не теряется.
      await api(`/clients/${chat.client.id}/notes`, {
        method: "POST",
        body: { body: text, run_ai: true, source_type: "text" },
      });
      setChatDraft("");
      const fresh = await api<TaskChat>(`/tasks/${chat.task.id}/chat?limit=40`);
      setChat(fresh);
      await load();
    } catch (err) {
      // Текст остаётся в поле — менеджер не теряет написанное.
      setChatError(
        err instanceof Error
          ? `Заметка не сохранена: ${err.message}. Текст остался в поле.`
          : "Заметка не сохранена. Текст остался в поле.",
      );
    } finally {
      setChatSending(false);
    }
  }

  async function decideReview(
    taskId: string,
    decision: "accept" | "edit" | "reject",
    extra?: { title?: string; due_date?: string | null },
  ) {
    setBusy(taskId);
    try {
      const body: Record<string, unknown> = { decision };
      if (decision === "edit") {
        if (extra?.title) body.title = extra.title;
        if (extra?.due_date) body.due_date = extra.due_date;
      }
      await api(`/tasks/${taskId}/review`, { method: "POST", body });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось применить решение по задаче");
    } finally {
      setBusy(null);
    }
  }

  async function saveReschedule() {
    if (!reschedule || !newDate) return;
    setSavingDate(true);
    try {
      await api(`/tasks/${reschedule.id}/reschedule`, {
        method: "POST",
        body: { due_date: newDate, due_at: null },
      });
      setReschedule(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось перенести задачу");
    } finally {
      setSavingDate(false);
    }
  }

  /* --------------------------------------------------------- производные */
  const filtered = useMemo(() => {
    return tasks.filter((task) => {
      if (statusFilter !== "all" && task.status !== statusFilter) return false;
      if (typeFilter !== "all" && task.type !== typeFilter) return false;
      if (priorityFilter !== "all" && task.priority !== priorityFilter) return false;
      if (clientFilter !== "all" && task.client_id !== clientFilter) return false;
      return true;
    });
  }, [tasks, statusFilter, typeFilter, priorityFilter, clientFilter]);

  const today = todayISO();

  const overdue = useMemo(
    () => filtered.filter((t) => t.status === "open" && t.due_date && t.due_date < today),
    [filtered, today],
  );

  const byDate = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of filtered) {
      if (!task.due_date) continue;
      const list = map.get(task.due_date) ?? [];
      list.push(task);
      map.set(task.due_date, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.due_at && b.due_at) return a.due_at.localeCompare(b.due_at);
        if (a.due_at) return -1;
        if (b.due_at) return 1;
        return a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [filtered]);

  const undated = useMemo(
    () => filtered.filter((t) => t.status === "open" && !t.due_date),
    [filtered],
  );

  const reviewCount = useMemo(
    () => filtered.filter((t) => t.needs_review).length,
    [filtered],
  );

  const range = rangeOf(view, fromISO(anchor));
  const anchorDate = fromISO(anchor);

  const periodTasks = useMemo(
    () =>
      filtered
        .filter((t) => t.due_date && t.due_date >= range.from && t.due_date <= range.to)
        .sort((a, b) =>
          a.due_date === b.due_date
            ? (a.due_at ?? "").localeCompare(b.due_at ?? "")
            : (a.due_date ?? "").localeCompare(b.due_date ?? ""),
        ),
    [filtered, range.from, range.to],
  );

  const openInPeriod = periodTasks.filter((t) => t.status === "open").length;
  const doneInPeriod = periodTasks.filter((t) => t.status === "done").length;

  const activeFilters =
    (typeFilter !== "all" ? 1 : 0) +
    (priorityFilter !== "all" ? 1 : 0) +
    (statusFilter !== "open" ? 1 : 0) +
    (clientFilter !== "all" ? 1 : 0);

  function resetFilters() {
    setTypeFilter("all");
    setPriorityFilter("all");
    setStatusFilter("open");
    setClientFilter("all");
  }

  /* ------------------------------------------------------------- разметка */
  return (
    <div className="mx-auto max-w-[1240px]">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.026em] text-ink sm:text-[28px]">
            Планировщик
          </h1>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            {range.label} · {openInPeriod} в работе
            {doneInPeriod > 0 ? `, ${doneInPeriod} закрыто` : ""}
            {overdue.length > 0 ? ` · ${overdue.length} просрочено` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-control border border-[var(--border-strong)] bg-surface p-0.5">
            {VIEWS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setView(item.key)}
                aria-pressed={view === item.key}
                className={`focus-ring h-11 min-h-[44px] rounded-[9px] px-3 text-[13px] font-medium transition-colors sm:h-9 sm:min-h-9 ${
                  view === item.key
                    ? "bg-primary text-white"
                    : "text-[var(--muted)] hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setAnchor(toISO(shiftPeriod(view, anchorDate, -1)))}
              aria-label="Предыдущий период"
              className="focus-ring grid h-11 w-11 place-items-center rounded-control border border-[var(--border-strong)] text-[var(--muted)] transition-colors hover:border-primary hover:text-primary sm:h-10 sm:w-10"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <Button variant="outline" size="md" onClick={() => setAnchor(todayISO())}>
              Сегодня
            </Button>
            <button
              type="button"
              onClick={() => setAnchor(toISO(shiftPeriod(view, anchorDate, 1)))}
              aria-label="Следующий период"
              className="focus-ring grid h-11 w-11 place-items-center rounded-control border border-[var(--border-strong)] text-[var(--muted)] transition-colors hover:border-primary hover:text-primary sm:h-10 sm:w-10"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Фильтры: тип, приоритет, статус, клиент (п.73) */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          aria-label="Тип задачи"
          className={`${inputClass} h-10 w-auto min-w-[130px]`}
        >
          <option value="all">Все типы</option>
          {Object.entries(TASK_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          aria-label="Приоритет"
          className={`${inputClass} h-10 w-auto min-w-[130px]`}
        >
          <option value="all">Любой приоритет</option>
          {Object.entries(PRIORITY_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Статус"
          className={`${inputClass} h-10 w-auto min-w-[130px]`}
        >
          <option value="open">Открытые</option>
          <option value="done">Закрытые</option>
          <option value="all">Все</option>
        </select>

        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          aria-label="Клиент"
          className={`${inputClass} h-10 w-auto min-w-[160px] max-w-[240px]`}
        >
          <option value="all">Все клиенты</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>

        {activeFilters > 0 && (
          <button
            type="button"
            onClick={resetFilters}
            className="focus-ring h-10 rounded-control px-2.5 text-[13px] font-medium text-primary underline decoration-dotted"
          >
            Сбросить ({activeFilters})
          </button>
        )}

        <div className="flex-1" />

        <Link
          href="/today"
          className="focus-ring inline-flex h-11 min-h-[44px] items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium text-[var(--muted)] hover:text-primary sm:h-10 sm:min-h-10"
        >
          Открыть «Сегодня»
        </Link>
      </div>

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

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-14 rounded-card" />
          <Skeleton className="h-80 rounded-card" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Просрочка и «Уточнить» видны в любом режиме (п.74) */}
          {(overdue.length > 0 || reviewCount > 0) && (
            <div className="flex flex-wrap gap-2">
              {overdue.length > 0 && (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-3 py-2">
                  <Badge tone="danger">{overdue.length}</Badge>
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-[var(--danger)]">
                    просрочено — сроки уже прошли
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setView("day");
                      setAnchor(overdue[overdue.length - 1].due_date ?? today);
                    }}
                    className="focus-ring h-8 rounded-lg border border-[var(--danger)] px-2.5 text-[12.5px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)] hover:text-white"
                  >
                    Показать
                  </button>
                </div>
              )}
              {reviewCount > 0 && (
                <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-card border border-[#f1dfae] bg-[var(--warning-soft)] px-3 py-2">
                  <Badge tone="warning">{reviewCount}</Badge>
                  <span className="min-w-0 flex-1 text-[13px] leading-snug text-[#8a6410]">
                    без срока или требуют уточнения
                  </span>
                  {/* Без этой кнопки задачи без срока были видны только в режиме
                      «День», и из «Недели» до них было не добраться: бейдж
                      показывал число, но не давал открыть список. */}
                  <button
                    type="button"
                    onClick={() => setView("day")}
                    className="focus-ring inline-flex h-8 min-h-[44px] items-center rounded-lg border border-[#d9c07a] px-2.5 text-[12.5px] font-medium text-[#8a6410] transition-colors hover:bg-[#f6e8bd] sm:min-h-0"
                  >
                    Показать и задать срок
                  </button>
                </div>
              )}
            </div>
          )}

          {view === "day" && (
            <DayView
              date={anchor}
              tasks={byDate.get(anchor) ?? []}
              undated={undated}
              busy={busy}
              onComplete={complete}
              onReopen={reopen}
              onReschedule={openReschedule}
              onDecide={decideReview}
              onOpenChat={openChat}
            />
          )}

          {view === "week" && (
            <WeekView
              anchor={anchorDate}
              byDate={byDate}
              today={today}
              busy={busy}
              onComplete={complete}
              onReopen={reopen}
              onReschedule={openReschedule}
              onPickDay={(iso) => {
                setAnchor(iso);
                setView("day");
              }}
            />
          )}

          {view === "month" && (
            <MonthView
              anchor={anchorDate}
              byDate={byDate}
              today={today}
              onPickDay={(iso) => {
                setAnchor(iso);
                setView("day");
              }}
            />
          )}

          {view === "year" && (
            <YearView
              anchor={anchorDate}
              byDate={byDate}
              today={today}
              onPickMonth={(monthIndex) => {
                setAnchor(toISO(new Date(anchorDate.getFullYear(), monthIndex, 1)));
                setView("month");
              }}
            />
          )}

          {view !== "day" && openInPeriod === 0 && overdue.length === 0 && (
            <Card>
              <EmptyState
                title="На этот период задач нет"
                description="Выберите другой период или добавьте задачу из карточки клиента."
              />
            </Card>
          )}
        </div>
      )}

      {/* Перенос срока — диалог, а не drag-and-drop (п.76) */}
      <Modal
        open={Boolean(reschedule)}
        title="Перенести задачу"
        onClose={() => setReschedule(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setReschedule(null)}>
              Отмена
            </Button>
            <Button onClick={() => void saveReschedule()} loading={savingDate} disabled={!newDate}>
              Перенести
            </Button>
          </>
        }
      >
        {reschedule && (
          <div className="space-y-3">
            <p className="text-[14px] leading-snug text-ink">{reschedule.title}</p>
            <p className="text-[12.5px] text-[var(--muted)]">
              Сейчас: {reschedule.due_date ? dateRu(reschedule.due_date) : "без срока"}
              {reschedule.client_name ? ` · ${reschedule.client_name}` : ""}
            </p>
            <Field label="Новый срок">
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {[0, 1, 3, 7].map((offset) => {
                const iso = toISO(addDays(new Date(), offset));
                return (
                  <button
                    key={offset}
                    type="button"
                    onClick={() => setNewDate(iso)}
                    className="focus-ring h-8 rounded-lg border border-[var(--border)] px-2.5 text-[12.5px] text-[var(--muted)] transition-colors hover:border-primary hover:text-primary"
                  >
                    {offset === 0 ? "Сегодня" : offset === 1 ? "Завтра" : `Через ${offset} дн.`}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </Modal>

      {/*
        Задача как чат: история заметок клиента + поле ввода новой.
        Открывается кликом по названию задачи — менеджер сразу видит,
        о чём договаривались, и продолжает разговор на месте.
      */}
      <Modal
        open={Boolean(chatTaskId)}
        title={chat?.task.title ?? "Задача"}
        onClose={() => {
          setChatTaskId(null);
          setChat(null);
          setChatError(null);
        }}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setChatTaskId(null);
                setChat(null);
                setChatError(null);
              }}
            >
              Закрыть
            </Button>
            {chat && (
              <Button
                onClick={() => void sendChatNote()}
                loading={chatSending}
                disabled={!chatDraft.trim()}
              >
                Добавить заметку
              </Button>
            )}
          </>
        }
      >
        {chatLoading && (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-control" />
            <Skeleton className="h-16 rounded-control" />
            <Skeleton className="h-16 rounded-control" />
          </div>
        )}

        {chatError && !chat && (
          <ErrorState
            title="Не удалось открыть задачу"
            description={chatError}
            onRetry={() => chatTaskId && void openChat(chatTaskId)}
          />
        )}

        {chat && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[var(--muted)]">
              <Link
                href={`/clients/${chat.client.id}`}
                className="font-medium text-primary hover:underline focus-ring rounded"
              >
                {chat.client.name}
              </Link>
              <span>{TASK_TYPE_LABELS[chat.task.type] ?? chat.task.type}</span>
              <span>{PRIORITY_LABELS[chat.task.priority] ?? chat.task.priority}</span>
              <span>
                {chat.task.due_date ? `срок ${dateRu(chat.task.due_date)}` : "без срока"}
              </span>
              {chat.task.source_quote && (
                <span className="w-full border-l-2 border-[var(--border-strong)] pl-2 italic">
                  «{chat.task.source_quote}»
                </span>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                История заметок клиента
              </p>
              {chat.notes.length === 0 ? (
                <EmptyState
                  title="Заметок пока нет"
                  description="Напишите первую — она появится здесь и в ленте заметок."
                />
              ) : (
                <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
                  {chat.notes.map((note) => (
                    <div
                      key={note.id}
                      className="rounded-control border border-[var(--border)] bg-[#f8fafd] px-2.5 py-2"
                    >
                      <div className="mb-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[var(--muted)]">
                        <span>{dateTimeRu(note.created_at)}</span>
                        {note.author_name && <span>{note.author_name}</span>}
                        {note.source_type === "voice" && <span>голос</span>}
                        {note.spawned_task && (
                          <span className="rounded-full bg-[var(--primary-soft)] px-1.5 py-0.5 text-[10.5px] font-semibold text-primary">
                            отсюда задача
                          </span>
                        )}
                      </div>
                      <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink">
                        {note.body}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {chat.has_more && (
                <p className="mt-1.5 text-[12px] text-[var(--muted)]">
                  Показаны последние {chat.notes.length}. Более ранние — в разделе «Заметки».
                </p>
              )}
            </div>

            <Field label="Новая заметка по этой задаче">
              <textarea
                value={chatDraft}
                onChange={(e) => setChatDraft(e.target.value)}
                rows={3}
                placeholder="Например: созвонился, ждём счёт до пятницы"
                className={textareaClass}
              />
            </Field>
            {chatError && <p className="text-[12.5px] text-[var(--danger)]">{chatError}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------ День */

/** Сколько задач «Без срока» показывать до нажатия «Показать все». */
const UNDATED_PREVIEW = 12;

function DayView({
  date,
  tasks,
  undated,
  busy,
  onComplete,
  onReopen,
  onReschedule,
  onDecide,
  onOpenChat,
}: {
  date: string;
  tasks: Task[];
  undated: Task[];
  busy: string | null;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onReschedule: (task: Task) => void;
  onDecide: (taskId: string, decision: "accept" | "edit" | "reject") => void;
  onOpenChat: (taskId: string) => void;
}) {
  const withTime = tasks.filter((t) => t.due_at);
  const withoutTime = tasks.filter((t) => !t.due_at);
  // «Без срока» может содержать сотни импортированных задач. Показываем
  // первые UNDATED_PREVIEW и даём явно раскрыть список: молча прятать
  // 120+ задач нельзя — менеджер считает, что их нет вообще.
  const [showAllUndated, setShowAllUndated] = useState(false);
  const visibleUndated = showAllUndated ? undated : undated.slice(0, UNDATED_PREVIEW);

  return (
    <div className="space-y-3">
      <Card>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">
            {dateRu(date)}
          </h2>
          <span className="text-[12.5px] text-[var(--muted)]">
            {tasks.length > 0 ? `${tasks.length} задач` : "свободно"}
          </span>
        </div>

        {withTime.length > 0 && (
          <div className="space-y-0.5">
            {withTime.map((task) => (
              <TaskLine
                key={task.id}
                task={task}
                time={timeOf(task.due_at)}
                busy={busy === task.id}
                onComplete={() => onComplete(task.id)}
                onReopen={() => onReopen(task.id)}
                onReschedule={() => onReschedule(task)}
                onDecide={onDecide}
                onOpenChat={() => onOpenChat(task.id)}
              />
            ))}
          </div>
        )}

        {withoutTime.length > 0 && (
          <>
            <p className="mb-1 mt-3 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
              Без времени
            </p>
            <div className="space-y-0.5">
              {withoutTime.map((task) => (
                <TaskLine
                  key={task.id}
                  task={task}
                  time={null}
                  busy={busy === task.id}
                  onComplete={() => onComplete(task.id)}
                  onReopen={() => onReopen(task.id)}
                  onReschedule={() => onReschedule(task)}
                  onDecide={onDecide}
                  onOpenChat={() => onOpenChat(task.id)}
                />
              ))}
            </div>
          </>
        )}

        {tasks.length === 0 && (
          <EmptyState
            title="На этот день задач нет"
            description="Можно перенести задачу из другого дня — кнопкой «Перенести»."
          />
        )}
      </Card>

      {undated.length > 0 && (
        <Card>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold text-ink">Без срока</h2>
            <span className="text-[12.5px] text-[var(--muted)]">{undated.length}</span>
          </div>
          <div className="space-y-0.5">
            {visibleUndated.map((task) => (
              <TaskLine
                key={task.id}
                task={task}
                time={null}
                busy={busy === task.id}
                onComplete={() => onComplete(task.id)}
                onReopen={() => onReopen(task.id)}
                onReschedule={() => onReschedule(task)}
                onDecide={onDecide}
                onOpenChat={() => onOpenChat(task.id)}
              />
            ))}
          </div>
          {undated.length > UNDATED_PREVIEW && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12.5px] text-[var(--muted)]">
                {showAllUndated
                  ? `показаны все ${undated.length} — задайте срок, чтобы они попали в календарь`
                  : `и ещё ${undated.length - UNDATED_PREVIEW} — задайте срок, чтобы они попали в календарь`}
              </p>
              <button
                type="button"
                onClick={() => setShowAllUndated((v) => !v)}
                aria-expanded={showAllUndated}
                className="focus-ring inline-flex h-8 items-center rounded-lg border border-[var(--border-strong)] px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-[#eef2f8]"
              >
                {showAllUndated
                  ? `Свернуть до ${UNDATED_PREVIEW}`
                  : `Показать все (${undated.length})`}
              </button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- Неделя */

function WeekView({
  anchor,
  byDate,
  today,
  busy,
  onComplete,
  onReopen,
  onReschedule,
  onPickDay,
}: {
  anchor: Date;
  byDate: Map<string, Task[]>;
  today: string;
  busy: string | null;
  onComplete: (id: string) => void;
  onReopen: (id: string) => void;
  onReschedule: (task: Task) => void;
  onPickDay: (iso: string) => void;
}) {
  const start = startOfWeek(anchor);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
      {days.map((day) => {
        const iso = toISO(day);
        const list = byDate.get(iso) ?? [];
        const isToday = iso === today;
        return (
          <div
            key={iso}
            className={`min-w-0 rounded-card border bg-surface p-2.5 shadow-soft ${
              isToday ? "border-primary" : "border-[var(--border)]"
            }`}
          >
            <button
              type="button"
              onClick={() => onPickDay(iso)}
              className="focus-ring mb-1.5 flex min-h-[44px] w-full items-center justify-between gap-1 rounded px-0.5"
            >
              <span className={`text-[12.5px] font-semibold ${isToday ? "text-primary" : "text-ink"}`}>
                {WEEKDAYS[(day.getDay() + 6) % 7]}, {day.getDate()}
              </span>
              {list.length > 0 && (
                <span className="text-[11.5px] text-[var(--muted)]">{list.length}</span>
              )}
            </button>

            {list.length === 0 ? (
              <p className="py-2 text-[11.5px] text-[#6B7280]">пусто</p>
            ) : (
              <div className="space-y-1">
                {list.slice(0, 6).map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => onReschedule(task)}
                    title={`${task.title}${task.client_name ? ` · ${task.client_name}` : ""}`}
                    className={`block min-h-[44px] w-full break-words rounded-md px-1.5 py-1.5 text-left text-[12px] leading-snug transition-colors hover:bg-[#f1f4f9] ${
                      task.status === "done"
                        ? "text-[var(--muted)] line-through"
                        : task.priority === "critical"
                          ? "text-[var(--danger)]"
                          : "text-ink"
                    }`}
                  >
                    {timeOf(task.due_at) && (
                      <span className="tabular mr-1 text-[11px] text-[var(--muted)]">
                        {timeOf(task.due_at)}
                      </span>
                    )}
                    {task.title}
                  </button>
                ))}
                {list.length > 6 && (
                  <button
                    type="button"
                    onClick={() => onPickDay(iso)}
                    className="focus-ring flex min-h-[44px] items-center text-[11.5px] font-medium text-primary hover:underline"
                  >
                    ещё {list.length - 6}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- Месяц */

function MonthView({
  anchor,
  byDate,
  today,
  onPickDay,
}: {
  anchor: Date;
  byDate: Map<string, Task[]>;
  today: string;
  onPickDay: (iso: string) => void;
}) {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const total = daysInMonth(year, month);
  const cells = Math.ceil((offset + total) / 7) * 7;

  return (
    <Card padded={false} className="overflow-hidden">
      <div className="grid grid-cols-7 border-b border-[var(--border)] bg-[#f8fafd]">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="px-1.5 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]"
          >
            {day}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {Array.from({ length: cells }).map((_, index) => {
          const dayNumber = index - offset + 1;
          const valid = dayNumber >= 1 && dayNumber <= total;
          const iso = valid ? toISO(new Date(year, month, dayNumber)) : "";
          const list = valid ? byDate.get(iso) ?? [] : [];
          const open = list.filter((t) => t.status === "open");
          const isToday = valid && iso === today;
          const isPast = valid && iso < today;

          if (!valid) {
            return <div key={index} className="min-h-[76px] border-b border-r border-[var(--border)] bg-[#fbfcfe]" />;
          }

          return (
            <button
              key={index}
              type="button"
              onClick={() => onPickDay(iso)}
              className={`focus-ring min-h-[76px] border-b border-r border-[var(--border)] p-1.5 text-left transition-colors hover:bg-[#f7f9fc] ${
                isToday ? "bg-[var(--primary-soft)]" : ""
              }`}
            >
              <span className="flex items-center justify-between gap-1">
                <span
                  className={`tabular text-[12.5px] ${
                    isToday ? "font-semibold text-primary" : "text-ink"
                  }`}
                >
                  {dayNumber}
                </span>
                {open.length > 0 && (
                  <span
                    className={`rounded-full px-1 py-0.5 text-[10.5px] font-semibold leading-none ${
                      isPast
                        ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                        : "bg-[#eef2f8] text-[var(--muted)]"
                    }`}
                  >
                    {open.length}
                  </span>
                )}
              </span>
              <span className="mt-1 block space-y-0.5">
                {list.slice(0, 2).map((task) => (
                  <span
                    key={task.id}
                    className={`block truncate text-[10.5px] leading-tight ${
                      task.status === "done" ? "text-[#6B7280] line-through" : "text-[var(--muted)]"
                    }`}
                  >
                    {task.title}
                  </span>
                ))}
                {list.length > 2 && (
                  <span className="block text-[10.5px] text-primary">+{list.length - 2}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------- Год */

function YearView({
  anchor,
  byDate,
  today,
  onPickMonth,
}: {
  anchor: Date;
  byDate: Map<string, Task[]>;
  today: string;
  onPickMonth: (monthIndex: number) => void;
}) {
  const year = anchor.getFullYear();
  const currentMonth = fromISO(today).getMonth();
  const currentYear = fromISO(today).getFullYear();

  const stats = useMemo(() => {
    const result = MONTHS.map((label, monthIndex) => {
      const total = daysInMonth(year, monthIndex);
      let open = 0;
      let done = 0;
      let overdue = 0;
      for (let day = 1; day <= total; day += 1) {
        const iso = toISO(new Date(year, monthIndex, day));
        for (const task of byDate.get(iso) ?? []) {
          if (task.status === "done") done += 1;
          else {
            open += 1;
            if (iso < today) overdue += 1;
          }
        }
      }
      return { label, monthIndex, open, done, overdue };
    });
    return result;
  }, [byDate, year, today]);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {stats.map((month) => {
        const isCurrent = year === currentYear && month.monthIndex === currentMonth;
        return (
          <button
            key={month.label}
            type="button"
            onClick={() => onPickMonth(month.monthIndex)}
            className={`focus-ring min-w-0 rounded-card border bg-surface p-3 text-left shadow-soft transition-colors hover:border-primary ${
              isCurrent ? "border-primary" : "border-[var(--border)]"
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className={`text-[14px] font-semibold ${isCurrent ? "text-primary" : "text-ink"}`}>
                {month.label}
              </span>
              {month.open > 0 && (
                <span className="tabular text-[12.5px] text-[var(--muted)]">{month.open}</span>
              )}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]">
              {month.open === 0 && month.done === 0 ? (
                <span className="text-[#6B7280]">нет задач</span>
              ) : (
                <>
                  {month.open > 0 && (
                    <span className="text-[var(--muted)]">{month.open} открыто</span>
                  )}
                  {month.done > 0 && (
                    <span className="text-[var(--success)]">{month.done} закрыто</span>
                  )}
                  {month.overdue > 0 && (
                    <span className="font-medium text-[var(--danger)]">
                      {month.overdue} просрочено
                    </span>
                  )}
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------- строка задачи */

function TaskLine({
  task,
  time,
  busy,
  onComplete,
  onReopen,
  onReschedule,
  onDecide,
  onOpenChat,
}: {
  task: Task;
  time: string | null;
  busy: boolean;
  onComplete: () => void;
  onReopen: () => void;
  onReschedule: () => void;
  onDecide: (taskId: string, decision: "accept" | "edit" | "reject") => void;
  onOpenChat: () => void;
}) {
  const done = task.status === "done";
  const overdue = !done && task.due_date ? task.due_date < todayISO() : false;

  return (
    <div className="group relative flex items-start gap-2 rounded-control px-1 py-1.5 transition-colors hover:bg-[#f8fafd]">
      {overdue && (
        <span aria-hidden className="my-1.5 w-[3px] shrink-0 self-stretch rounded-full bg-[var(--danger)]" />
      )}

      <button
        type="button"
        onClick={done ? onReopen : onComplete}
        disabled={busy}
        title={done ? "Вернуть в работу" : "Выполнить задачу"}
        aria-label={done ? `Вернуть: ${task.title}` : `Выполнить: ${task.title}`}
        className={`focus-ring my-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition-colors disabled:opacity-50 ${
          done
            ? "border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]"
            : "border-[var(--border-strong)] text-transparent hover:border-[var(--success)] hover:bg-[var(--success-soft)] hover:text-[var(--success)]"
        }`}
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent text-[var(--muted)]" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </button>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {time && <span className="tabular text-[12px] font-medium text-primary">{time}</span>}
          {/*
            Название задачи — кнопка: открывает карточку-чат с историей
            заметок клиента. Так задача перестаёт быть строкой без контекста.
          */}
          <button
            type="button"
            onClick={onOpenChat}
            title="Открыть задачу: история заметок и новая запись"
            className={`min-w-0 break-words text-left text-[14px] leading-snug transition-colors hover:text-primary focus-ring rounded ${
              done ? "text-[var(--muted)] line-through" : "text-ink"
            }`}
          >
            {task.title}
          </button>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--muted)]">
          {task.client_id && (
            <Link
              href={`/clients/${task.client_id}`}
              className="max-w-[220px] truncate font-medium hover:text-primary focus-ring rounded"
            >
              {task.client_name ?? "Клиент"}
            </Link>
          )}
          <span>{TASK_TYPE_LABELS[task.type] ?? task.type}</span>
          {task.priority !== "normal" && (
            <span
              className={
                task.priority === "critical"
                  ? "font-medium text-[var(--danger)]"
                  : task.priority === "high"
                    ? "font-medium text-[#B45309]"
                    : ""
              }
            >
              {PRIORITY_LABELS[task.priority] ?? task.priority}
            </span>
          )}
          {!done && task.due_date && <span>{relativeDay(`${task.due_date}T00:00:00Z`).toLowerCase()}</span>}
          {task.event_kind === "waiting" && (
            <span className="rounded-full bg-[#fff1d6] px-1.5 py-0.5 text-[11px] font-semibold text-[#8a6410]">
              {task.actor === "client" ? "ждём клиента" : "ждём"}
            </span>
          )}
          {task.needs_review && <ReviewChip reason={task.review_question ?? task.review_reason} />}
        </div>

        {/* п.14: конкретный вопрос вместо безликого «Уточнить срок» */}
        {task.needs_review && task.review_question && (
          <p className="mt-1 text-[12px] leading-snug text-[#8a6410]">{task.review_question}</p>
        )}

        {/* п.17: исходная фраза — видно, из чего родилась задача */}
        {task.source_quote && (
          <details className="mt-1">
            <summary className="cursor-pointer list-none text-[11.5px] font-medium text-primary hover:underline">
              Откуда задача?
            </summary>
            <p className="mt-1 rounded-md border-l-2 border-[var(--border-strong)] bg-white px-2 py-1 text-[12px] italic leading-snug text-[var(--muted)]">
              «{task.source_quote}»
            </p>
          </details>
        )}

        {/* п.23: принять / изменить срок / отклонить — прямо в строке */}
        {task.needs_review && !done && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onDecide(task.id, "accept")}
              disabled={busy}
              className="focus-ring inline-flex h-8 items-center rounded-lg bg-[var(--primary-soft)] px-2.5 text-[12px] font-medium text-primary transition-colors hover:bg-[#dce8fb] disabled:opacity-50"
            >
              Принять
            </button>
            <button
              type="button"
              onClick={onReschedule}
              disabled={busy}
              className="focus-ring inline-flex h-8 items-center rounded-lg border border-[var(--border-strong)] px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-[#eef2f8] disabled:opacity-50"
            >
              Задать срок
            </button>
            <button
              type="button"
              onClick={() => onDecide(task.id, "reject")}
              disabled={busy}
              className="focus-ring inline-flex h-8 items-center rounded-lg px-2.5 text-[12px] font-medium text-[var(--muted)] transition-colors hover:bg-[#eef2f8] hover:text-[var(--danger)] disabled:opacity-50"
            >
              Отклонить
            </button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!done && (
          <button
            type="button"
            onClick={onReschedule}
            className="focus-ring h-8 rounded-lg px-2 text-[12px] font-medium text-[var(--muted)] transition-colors hover:bg-[#eef2f8] hover:text-primary"
          >
            Перенести
          </button>
        )}
        {done && (
          <button
            type="button"
            onClick={onReopen}
            disabled={busy}
            className="focus-ring h-8 rounded-lg px-2 text-[12px] font-medium text-[var(--muted)] transition-colors hover:bg-[#eef2f8] hover:text-primary disabled:opacity-50"
          >
            Вернуть
          </button>
        )}
      </div>
    </div>
  );
}

/** Дата задачи или сегодня — для подстановки в поле переноса. */
function fromDate(task: Task): Date {
  return task.due_date ? fromISO(task.due_date) : new Date();
}
