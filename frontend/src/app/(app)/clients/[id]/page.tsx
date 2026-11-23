"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

/*
 * ВАЖНО: здесь НЕ используется useSearchParams().
 * В Next.js 15 App Router этот хук требует Suspense-границы на уровне
 * страницы; без неё клиентский компонент зависает и страница не отдаётся
 * (замер: таймаут 90 с на /clients/{id}). Вкладку читаем из window.location
 * и пишем через history.replaceState — без ре-рендера роутера.
 */
function readTabFromUrl(): Tab | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("tab");
  return TAB_KEYS.includes(value as Tab) ? (value as Tab) : null;
}

import { TaskChatBody, useTaskChat } from "@/components/TaskChat";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  KpiCard,
  Modal,
  MoneyValue,
  SectionTitle,
  Skeleton,
  StatusBadge,
  TaskRow,
  inputClass,
  textareaClass,
} from "@/components/ui";
import {
  api,
  API_ROOT,
  ClientContract,
  ClientDetail,
  ClientDocument,
  ClientHistoryEvent,
  FinancialSummary,
  Note,
  Project,
  Task,
} from "@/lib/api";
import {
  dateRu,
  dateTimeRu,
  formatBytes,
  isOverdue,
  money,
  relativeDay,
} from "@/lib/format";

/**
 * Семь вкладок карточки клиента (DESIGN TASKS v2.1, п.34-40).
 * «Контакты» и «Документы» вынесены отдельно: раньше их не было в UI,
 * хотя эндпоинты /contacts и /documents существовали.
 * Вкладка хранится в URL (?tab=finance) — можно дать ссылку коллеге (п.43).
 */
type Tab =
  | "overview"
  | "notes"
  | "tasks"
  | "projects"
  | "finance"
  | "documents"
  | "history";

const TAB_KEYS: Tab[] = [
  "overview", "notes", "tasks", "projects", "finance", "documents", "history",
];

function tabFromQuery(value: string | null): Tab {
  return TAB_KEYS.includes(value as Tab) ? (value as Tab) : "overview";
}

/** Как называть событие аудита человеку (A-P0-2). */
const HISTORY_RU: Record<string, string> = {
  "client:created": "Клиент создан",
  "client:updated": "Карточка клиента изменена",
  "client:deleted": "Клиент удалён",
  "client:transferred": "Клиент передан другому менеджеру",
  "invoice:created": "Выставлен счёт",
  "invoice:updated": "Счёт изменён",
  "invoice:deleted": "Счёт удалён",
  "invoice:allocation_added": "Оплата зачтена по счёту",
  "invoice:allocation_removed": "Зачёт оплаты отменён",
  "payment:created": "Поступила оплата",
  "payment:updated": "Оплата изменена",
  "task:created": "Создана задача",
  "task:completed": "Задача выполнена",
  "task:reopened": "Задача возвращена в работу",
  "task:rescheduled": "Перенесён срок задачи",
  "task:deleted": "Задача удалена",
  "note:created": "Добавлена заметка",
  "note:reprocessed": "Заметка разобрана повторно",
  "project:created": "Создан проект",
  "project:updated": "Проект изменён",
};

/** События, которые важны для денег — их подсвечиваем. */
const MONEY_ENTITIES = new Set(["invoice", "payment", "allocation"]);

function historyTone(entity: string, action: string): string {
  if (MONEY_ENTITIES.has(entity)) {
    return action.includes("removed") || action === "deleted"
      ? "bg-[var(--danger)]"
      : "bg-[var(--success)]";
  }
  if (entity === "task") return "bg-[var(--warning)]";
  return "bg-primary";
}

function historyAmount(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const value = metadata.amount;
  if (typeof value !== "number") return null;
  return money(value);
}

/** Статусы AI по-человечески: раньше в интерфейсе висело «AI: ok». */
const AI_STATUS_RU: Record<
  string,
  { label: string; tone: "success" | "danger" | "warning" | "neutral" }
> = {
  ok: { label: "AI разобрал", tone: "success" },
  pending: { label: "AI в очереди", tone: "warning" },
  queued: { label: "AI в очереди", tone: "warning" },
  running: { label: "AI разбирает", tone: "warning" },
  failed: { label: "AI не смог", tone: "danger" },
  skipped: { label: "Без AI", tone: "neutral" },
  imported: { label: "Из импорта", tone: "neutral" },
};

const SOURCE_RU: Record<string, string> = {
  text: "текст",
  voice: "голос",
  import: "импорт",
  file: "файл",
};

/** Ключ дня в локальном времени — чтобы группировка не рвалась по UTC. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (same(date, today)) return "Сегодня";
  if (same(date, yesterday)) return "Вчера";
  return date.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

function groupNotesByDay(notes: Note[]): [string, Note[]][] {
  const map = new Map<string, Note[]>();
  for (const note of notes) {
    const key = dayKey(note.created_at);
    const bucket = map.get(key);
    if (bucket) bucket.push(note);
    else map.set(key, [note]);
  }
  return Array.from(map.entries());
}

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Обзор" },
  { key: "notes", label: "Заметки" },
  { key: "tasks", label: "Задачи" },
  { key: "projects", label: "Проекты" },
  { key: "finance", label: "Финансы" },
  { key: "documents", label: "Документы" },
  { key: "history", label: "История" },
];

export default function ClientPage() {
  const params = useParams<{ id: string }>();
  const clientId = params.id;

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [finance, setFinance] = useState<FinancialSummary | null>(null);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [contracts, setContracts] = useState<ClientContract[]>([]);
  const [history, setHistory] = useState<ClientHistoryEvent[]>([]);
  const [tab, setTabState] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);

  // Пункт 43: вкладку восстанавливаем из URL после монтирования.
  useEffect(() => {
    const fromUrl = readTabFromUrl();
    if (fromUrl) setTabState(fromUrl);
  }, [clientId]);

  /** Пункт 43: вкладка в URL, смена не сбрасывает выбранного клиента. */
  const setTab = useCallback(
    (next: Tab) => {
      setTabState(next);
      const url = new URL(window.location.href);
      url.searchParams.set("tab", next);
      window.history.replaceState(null, "", url.toString());
    },
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [saving, setSaving] = useState(false);
  const chat = useTaskChat();

  /**
   * Пункт 40 + A-P0-2: история существенных действий из журнала аудита.
   * Раньше она собиралась в браузере из заметок и выполненных задач — правки
   * финансов, смены статуса и передачи клиента туда не попадали. Теперь
   * источник — `/clients/{id}/history`, то есть фактические события сервера.
   */
  const historyItems = useMemo(
    () =>
      history.map((event) => ({
        at: event.created_at,
        title:
          HISTORY_RU[`${event.entity}:${event.action}`] ??
          `${event.entity}: ${event.action}`,
        tone: historyTone(event.entity, event.action),
        amount: historyAmount(event.metadata),
        actor: event.actor,
      })),
    [history],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [detail, projectList, taskList, notePage, fin, docs, contractList, auditPage] =
        await Promise.all([
          api<ClientDetail>(`/clients/${clientId}`),
          api<Project[]>(`/clients/${clientId}/projects`),
          api<{ items: Task[] }>(`/tasks?client_id=${clientId}&status=all&limit=200`),
          /*
           * Эндпоинт отдаёт {items, total}: рядом с каждой заметкой едет
           * task_count / open_task_count / tasks. Раньше ожидался массив —
           * из-за этого история выглядела пустой при пяти реальных заметках.
           */
          api<{ items: Note[]; total: number }>(`/clients/${clientId}/notes?limit=50`),
          api<FinancialSummary>(`/clients/${clientId}/financial-summary`),
          api<ClientDocument[]>(`/clients/${clientId}/documents`).catch(() => []),
          api<ClientContract[]>(`/clients/${clientId}/contracts`).catch(() => []),
          /*
           * A-P0-2: журнал аудита по клиенту. Ошибка здесь не должна ломать
           * карточку — остальные вкладки остаются работоспособными.
           */
          api<{ items: ClientHistoryEvent[] }>(`/clients/${clientId}/history?limit=100`)
            .catch(() => ({ items: [] })),
        ]);
      setClient(detail);
      setProjects(projectList);
      setTasks(taskList.items);
      setNotes(Array.isArray(notePage) ? notePage : notePage?.items ?? []);
      setFinance(fin);
      setDocuments(Array.isArray(docs) ? docs : []);
      setContracts(Array.isArray(contractList) ? contractList : []);
      setHistory(Array.isArray(auditPage?.items) ? auditPage.items : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить карточку клиента");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addNote(event: React.FormEvent) {
    event.preventDefault();
    if (!noteBody.trim()) return;
    setSaving(true);
    try {
      await api(`/clients/${clientId}/notes`, {
        method: "POST",
        body: { body: noteBody.trim(), run_ai: true, source_type: "text" },
      });
      setNoteBody("");
      setNoteOpen(false);
      await load();
      setTab("notes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить заметку");
    } finally {
      setSaving(false);
    }
  }

  async function complete(taskId: string) {
    await api(`/tasks/${taskId}/complete`, { method: "POST", body: {} });
    await load();
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-[1240px] space-y-4">
        <Skeleton className="h-24 rounded-card" />
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-card" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }

  if (error || !client) {
    return (
      <Card>
        <EmptyState
          title="Клиент недоступен"
          description={error ?? "Клиент не найден или принадлежит другому менеджеру."}
          action={
            <Link href="/clients">
              <Button variant="subtle" size="sm">К списку клиентов</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const openTasks = tasks.filter((t) => t.status === "open");
  const overdue = openTasks.filter((t) => isOverdue(t));

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <nav className="flex items-center gap-1.5 text-[12.5px] text-[var(--muted)]">
        <Link href="/clients" className="inline-flex min-h-[44px] items-center hover:text-primary sm:min-h-0">
          Клиенты
        </Link>
        <span>/</span>
        <span className="truncate text-ink">{client.name}</span>
      </nav>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-control bg-[var(--primary-soft)] text-[14px] font-semibold text-primary">
                {client.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-[20px] font-semibold tracking-[-0.02em] text-ink">{client.name}</h1>
                <p className="truncate text-[12.5px] text-[var(--muted)]">
                  {client.legal_name || "Юридическое лицо не указано"}
                  {client.address ? ` · ${client.address}` : ""}
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <StatusBadge status={client.status} />
              <Badge tone="neutral">создан {dateRu(client.created_at)}</Badge>
              <Badge tone="neutral">версия {client.version}</Badge>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setNoteOpen(true)}>
              Записать голосом
            </Button>
            <Button onClick={() => setNoteOpen(true)}>Добавить заметку</Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Проекты" value={client.projects_count} />
        <KpiCard label="Открытых задач" value={client.open_tasks} tone="primary" />
        <KpiCard label="Просрочено" value={overdue.length} tone={overdue.length ? "danger" : "neutral"} />
        <KpiCard label="Задолженность" value={money(finance?.debt ?? client.debt)} tone={(finance?.debt ?? 0) > 0 ? "danger" : "success"} />
      </div>

      {/*
        На мобильном 390px пятнадцать вкладок не влезают: «Проекты» упиралась
        в padding карточки и обрезалась. Отрицательные поля + такой же padding
        дают доскроллить до последней вкладки вплотную к краю.
      */}
      {/*
        role="tablist"/"tab" + aria-selected: без них экранный диктор читал
        вкладки как обычные кнопки и не сообщал, какая открыта (п.122).
      */}
      {/*
        п.41: полоса вкладок остаётся доступной при прокрутке длинной карточки.
        sticky + фон + blur, иначе под вкладками просвечивает контент.
        п.100: min-h-[44px] — зона нажатия не меньше 44 px.
      */}
      <div
        role="tablist"
        aria-label="Разделы карточки клиента"
        className="sticky top-0 z-20 -mx-4 flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--canvas)]/95 px-4 backdrop-blur md:mx-0 md:px-0"
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`focus-ring -mb-px min-h-[44px] shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] transition-colors ${
              tab === item.key
                ? "border-primary font-medium text-primary"
                : "border-transparent text-[var(--muted)] hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <Card>
              <SectionTitle title="Что требует внимания" subtitle="Просрочки и задачи без срока" />
              {overdue.length || openTasks.filter((t) => t.needs_review).length ? (
                <div className="-mx-1">
                  {[...overdue, ...openTasks.filter((t) => t.needs_review && !isOverdue(t))]
                    .slice(0, 8)
                    .map((task) => (
                      <div key={task.id} className="flex items-center gap-1">
                        <div className="min-w-0 flex-1">
                          <TaskRow task={task} onComplete={complete} />
                        </div>
                        <button
                          type="button"
                          onClick={() => void chat.open(task.id)}
                          className="focus-ring mr-1 shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-primary hover:bg-[var(--primary-soft)]"
                        >
                          Чат
                        </button>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="text-[13px] text-[var(--muted)]">Проблемных задач нет.</p>
              )}
            </Card>

            <Card>
              <SectionTitle
                title="Финансы"
                subtitle="Выставлено, оплачено и распределено"
                action={
                  <Button variant="ghost" size="sm" onClick={() => setTab("finance")}>
                    Подробнее
                  </Button>
                }
              />
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: "Выставлено", value: finance?.billed ?? 0 },
                  { label: "Оплачено", value: finance?.paid ?? 0 },
                  { label: "Долг", value: finance?.debt ?? 0 },
                ].map((item) => (
                  <div key={item.label} className="rounded-control bg-[#f8fafd] px-3 py-2.5">
                    <p className="text-[11px] uppercase tracking-[0.03em] text-[var(--muted)]">{item.label}</p>
                    <p className="mt-1 text-[15px] font-semibold text-ink">
                      <MoneyValue value={item.value} compact />
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-2.5 text-[11.5px] text-[var(--muted)]">
                Долг = выставлено по действующим счетам − распределённые оплаты. Плановый доход прибылью не является.
              </p>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <SectionTitle title="Контакты" subtitle={`${client.contacts.length} записей`} />
              {client.contacts.length ? (
                <ul className="space-y-2">
                  {client.contacts.map((contact) => (
                    <li key={contact.id} className="rounded-control border border-[var(--border)] px-3 py-2">
                      <p className="text-[13px] font-medium text-ink">{contact.name}</p>
                      <p className="text-[11.5px] text-[var(--muted)]">
                        {contact.position || "—"}
                        {contact.phone ? ` · ${contact.phone}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-[var(--muted)]">Контакты не добавлены.</p>
              )}
            </Card>

            <Card>
              <SectionTitle title="История" subtitle="Последние заметки" />
              {notes.length ? (
                <ul className="space-y-2.5">
                  {notes.slice(0, 4).map((note) => (
                    <li key={note.id} className="border-l-2 border-[var(--border-strong)] pl-2.5">
                      <p className="line-clamp-2 text-[12.5px] text-ink">{note.body}</p>
                      <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                        {dateTimeRu(note.created_at)} · {note.source_type}
                        {note.ai_status === "failed" ? " · AI: ошибка" : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-[var(--muted)]">Заметок пока нет.</p>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === "notes" && (
        <Card>
          <SectionTitle
            title="История заметок"
            subtitle={
              notes.length
                ? `${notes.length} заметок · ${notes.reduce((s, n) => s + (n.task_count ?? 0), 0)} задач из них`
                : "Источник AI-задач и обязательств"
            }
            action={<Button size="sm" onClick={() => setNoteOpen(true)}>Новая заметка</Button>}
          />
          {notes.length ? (
            <div className="space-y-5">
              {groupNotesByDay(notes).map(([day, dayNotes]) => (
                <section key={day}>
                  {/* Группировка по дням: в истории важно «когда», а не плоский список */}
                  <div className="mb-2 flex items-center gap-2.5">
                    <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                      {dayLabel(day)}
                    </h3>
                    <span className="text-[12px] text-[var(--muted)]">{dayNotes.length}</span>
                    <span className="h-px flex-1 bg-[var(--border)]" />
                  </div>
                  <ul className="space-y-2.5">
                    {dayNotes.map((note) => {
                      const ai = AI_STATUS_RU[note.ai_status] ?? {
                        label: note.ai_status,
                        tone: "neutral" as const,
                      };
                      return (
                        <li
                          key={note.id}
                          className="rounded-card border border-[var(--border)] bg-surface p-3.5 transition-colors hover:border-[var(--border-strong)]"
                        >
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Badge tone={ai.tone}>{ai.label}</Badge>
                            <Badge tone="neutral">{SOURCE_RU[note.source_type] ?? note.source_type}</Badge>
                            <span className="text-[12px] text-[var(--muted)]">
                              {new Date(note.created_at).toLocaleTimeString("ru-RU", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                            {note.task_count ? (
                              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-[#EFF6FF] px-2 py-1 text-[11.5px] font-medium text-[#2563EB]">
                                {note.open_task_count
                                  ? `${note.open_task_count} в работе`
                                  : `${note.task_count} задач`}
                              </span>
                            ) : null}
                          </div>
                          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">
                            {note.body}
                          </p>
                          {note.tasks?.length ? (
                            <ul className="mt-2.5 space-y-1 border-l-2 border-[#DBEAFE] pl-3">
                              {note.tasks.map((t, i) => (
                                <li key={i} className="flex items-start gap-1.5 text-[12.5px] text-[var(--muted)]">
                                  <span
                                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                                      t.status === "open" ? "bg-[#2563EB]" : "bg-[#22C55E]"
                                    }`}
                                  />
                                  <span className={t.status === "open" ? "" : "line-through"}>{t.title}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {note.ai_error && (
                            <p className="mt-2 rounded-lg bg-[#FEF2F2] px-2.5 py-1.5 text-[12px] text-[#EF4444]">
                              {note.ai_error}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <EmptyState
              title="Заметок нет"
              description="Добавьте заметку — AI извлечёт задачи и обязательства."
              action={<Button size="sm" variant="subtle" onClick={() => setNoteOpen(true)}>Добавить заметку</Button>}
            />
          )}
        </Card>
      )}

      {tab === "tasks" && (
        <Card>
          <SectionTitle title="Задачи клиента" subtitle={`${tasks.length} всего, ${openTasks.length} открыто`} />
          {tasks.length ? (
            <div className="-mx-1">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  onComplete={
                    task.status === "open"
                      ? complete
                      : undefined
                  }
                />
              ))}
              <p className="px-2.5 py-2 text-[12px] text-[var(--muted)]">
                Нажмите на название задачи в планировщике или на «Сегодня», чтобы открыть чат.
              </p>
            </div>
          ) : (
            <EmptyState title="Задач нет" description="Добавьте заметку с действиями или создайте задачу вручную." />
          )}
        </Card>
      )}

      {tab === "finance" && (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <Card>
            <SectionTitle title="Сводка" subtitle="По действующим счетам" />
            <dl className="space-y-2 text-[13px]">
              <Row label="Выставлено" value={money(finance?.billed ?? 0)} />
              <Row label="Оплачено" value={money(finance?.paid ?? 0)} />
              <Row label="Распределено" value={money(finance?.allocated ?? 0)} />
              <Row label="Долг" value={money(finance?.debt ?? 0)} danger={(finance?.debt ?? 0) > 0} />
              <Row label="Просроченные счета" value={money(finance?.overdue_amount ?? 0)} />
              <Row label="Счетов" value={`${finance?.invoices ?? 0} (неоплачено ${finance?.unpaid_invoices ?? 0})`} />
            </dl>
          </Card>
          <Card>
            <SectionTitle title="Позиция по смыслу" subtitle="Разделение счёта и поступления" />
            <ul className="space-y-2 text-[12.5px] leading-relaxed text-[var(--muted)]">
              <li>• Плановый доход проекта не равен прибыли.</li>
              <li>• Счёт и поступление — разные сущности; частичные платежи распределяются явно.</li>
              <li>• Суммы подтверждаются ручным вводом, ИИ не делает выводов из предположений.</li>
              <li>• Все корректировки финансов попадают в журнал аудита.</li>
            </ul>
          </Card>
        </div>
      )}

      {tab === "projects" && (
        <div className="space-y-3">
          {projects.length ? (
            projects.map((project) => (
              <Card key={project.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[15px] font-semibold text-ink">{project.name}</h3>
                    <p className="text-[12px] text-[var(--muted)]">
                      {project.location || "—"} · получен {dateRu(project.start_date)}
                      {project.stage_group ? ` · ${project.stage_group}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={project.status} />
                </div>
                <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="min-w-0 rounded-control border border-[var(--border)] bg-canvas px-3 py-2.5">
                    <dt className="text-[13px] text-[var(--muted)]">Плановый доход</dt>
                    <dd className="tabular mt-0.5 text-[15px] font-semibold text-ink">{money(project.planned_revenue)}</dd>
                  </div>
                  <div className="min-w-0 rounded-control border border-[var(--border)] bg-canvas px-3 py-2.5">
                    <dt className="text-[13px] text-[var(--muted)]">Ожидаемая прибыль</dt>
                    <dd className="tabular mt-0.5 text-[15px] font-semibold text-ink">{money(project.expected_profit)}</dd>
                  </div>
                </dl>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <ProjectBlock title="Сделано ранее" text={project.done_before} />
                  <ProjectBlock title="За последний спринт" text={project.done_last_sprint} />
                  <ProjectBlock title="Следующий спринт" text={project.plan_next_sprint} />
                </div>
                {project.problems_text && (
                  <div className="mt-3 rounded-control border border-[#f3d9b5] bg-[var(--warning-soft)] px-3 py-2">
                    <p className="text-[11px] font-medium uppercase tracking-[0.03em] text-[var(--warning)]">
                      Проблемы и сроки
                    </p>
                    <p className="mt-0.5 text-[12.5px] text-ink">{project.problems_text}</p>
                  </div>
                )}
                {project.meeting_comment && (
                  <p className="mt-2 text-[12px] text-[var(--muted)]">
                    Комментарий совещания: {project.meeting_comment}
                  </p>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <EmptyState title="Проектов нет" description="Добавьте проект клиента через API или импорт." />
            </Card>
          )}

          {/* Пункт 37: внутри проектов — договоры */}
          {contracts.length > 0 && (
            <Card>
              <SectionTitle title="Договоры" subtitle="Суммы договоров не равны оплатам" />
              <div className="divide-y divide-[var(--border)]">
                {contracts.map((contract) => (
                  <div key={contract.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-medium text-ink">
                        {contract.number ? `Договор №${contract.number}` : "Без номера"}
                      </p>
                      <p className="text-[12px] text-[var(--muted)]">
                        подписан {dateRu(contract.signed_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {contract.amount !== null && (
                        <span className="tabular text-[13px] font-medium text-ink">
                          {money(contract.amount)}
                        </span>
                      )}
                      <Badge tone="neutral">{contract.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ------------------------------------------------ Документы (п.39) */}
      {tab === "documents" && (
        <Card padded={false}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
            <div>
              <h2 className="text-[16.5px] font-semibold tracking-[-0.015em] text-ink">Документы</h2>
              <p className="mt-0.5 text-[12.5px] text-[var(--muted)]">
                Файлы клиента: тип, размер, дата и привязка к проекту или договору.
              </p>
            </div>
            <Badge tone="neutral">{documents.length}</Badge>
          </div>

          {documents.length ? (
            <div className="divide-y divide-[var(--border)]">
              {documents.map((doc) => (
                <div key={doc.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-[#f8fafd]">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--primary-soft)] text-primary">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                      <path d="M14 3v5h5" />
                    </svg>
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* Пункт 44: длинные названия переносим, а не обрезаем безвозвратно */}
                    <p className="break-words text-[13.5px] font-medium leading-snug text-ink">
                      {doc.filename}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-[var(--muted)]">
                      {doc.mime_type ?? "файл"}
                      {doc.size ? ` · ${formatBytes(doc.size)}` : ""}
                      {` · ${dateRu(doc.created_at)}`}
                      {doc.project_id ? " · привязан к проекту" : ""}
                    </p>
                  </div>
                  <a
                    href={`${API_ROOT}/api/v1/documents/${doc.id}/download`}
                    className="focus-ring shrink-0 rounded-lg border border-[var(--border-strong)] px-2.5 py-1.5 text-[12.5px] font-medium text-[var(--muted)] transition-colors hover:border-primary hover:text-primary"
                  >
                    Скачать
                  </a>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4">
              <EmptyState
                title="Документов нет"
                description="Файлы загружаются в карточке клиента или через импорт. Привязка к заметке появится в этапе B."
              />
            </div>
          )}
        </Card>
      )}

      {/* ------------------------------------------------ История (п.40) */}
      {tab === "history" && (
        <Card>
          <SectionTitle
            title="История"
            subtitle="Журнал действий по клиенту: счета и оплаты, задачи, изменения карточки"
          />
          {historyItems.length ? (
            <ol className="relative space-y-3 border-l border-[var(--border)] pl-4">
              {historyItems.map((item, index) => (
                <li key={`${item.at}-${index}`} className="relative">
                  <span
                    className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${item.tone}`}
                    aria-hidden
                  />
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <p className="text-[13.5px] leading-snug text-ink">{item.title}</p>
                    {item.amount ? (
                      <span className="text-[13px] font-semibold tabular-nums text-ink">
                        {item.amount}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-[11.5px] text-[var(--muted)]">
                    {dateTimeRu(item.at)}
                    {item.actor ? ` · ${item.actor}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState
              title="Событий пока нет"
              description="Здесь появятся выставленные счета, поступившие оплаты, зачёты и изменения по задачам."
            />
          )}
        </Card>
      )}

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
            const t = chat.draft.trim();
            if (!t || !chat.chat) return;
            chat.setSending(true);
            chat.setError(null);
            try {
              await api(`/clients/${chat.chat.client.id}/notes`, {
                method: "POST",
                body: { body: t, run_ai: true, source_type: "text" },
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

      <Modal
        open={noteOpen}
        title="Новая заметка"
        onClose={() => setNoteOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>Отмена</Button>
            <Button onClick={addNote} loading={saving} disabled={!noteBody.trim()}>
              Сохранить и извлечь задачи
            </Button>
          </>
        }
      >
        <form onSubmit={addNote} className="space-y-3">
          <Field
            label="Текст заметки"
            hint="Даты «завтра», «в пятницу», «25.11.2026» вычисляются от времени заметки в вашем часовом поясе."
          >
            <textarea
              value={noteBody}
              onChange={(e) => setNoteBody(e.target.value)}
              className={textareaClass}
              rows={6}
              placeholder="Созвонился с клиентом. Нужно отправить КП завтра. Клиент обещал оплатить счёт до 25.11.2026."
              autoFocus
            />
          </Field>
          <p className="text-[11.5px] text-[var(--muted)]">
            Заметка сохраняется сразу. AI создаёт задачи в фоне; при сбое заметка не теряется и остаётся в статусе «failed».
          </p>
        </form>
      </Modal>
    </div>
  );
}

function Row({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-dashed border-[var(--border)] pb-1.5 last:border-0">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className={danger ? "font-medium text-[var(--danger)]" : "font-medium text-ink"}>{value}</dd>
    </div>
  );
}

function ProjectBlock({ title, text }: { title: string; text: string | null }) {
  return (
    <div className="rounded-control bg-[#f8fafd] px-3 py-2">
      <p className="text-[10.5px] font-medium uppercase tracking-[0.04em] text-[var(--muted)]">{title}</p>
      <p className="mt-0.5 text-[12.5px] leading-snug text-ink">{text || "—"}</p>
    </div>
  );
}
