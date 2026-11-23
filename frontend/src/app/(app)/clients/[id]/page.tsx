"use client";

import Link from "next/link";
import { CreateTaskModal } from "@/components/CreateTaskModal";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ClientFinanceEntry } from "@/components/ClientFinanceEntry";
import { ContractModal } from "@/components/ContractModal";
import { ProjectBudgetModal } from "@/components/ProjectBudgetModal";
import { TaskChatBody, useTaskChat } from "@/components/TaskChat";
import { VoiceNoteForm } from "@/components/VoiceNoteForm";
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
} from "@/components/ui";
import {
  api,
  API_ROOT,
  ClientContract,
  ClientDetail,
  ClientDocument,
  ClientHistoryEvent,
  ClientInvoice,
  FinancialSummary,
  Note,
  Project,
  ProjectProvenance,
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
  "contract:created": "Договор заведён",
  "contract:updated": "Договор изменён",
  "contract:deleted": "Договор удалён",
  "contract:document_attached": "К договору прикреплён файл",
  "document:uploaded": "Загружен документ",
  "document:deleted": "Документ удалён",
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

/*
 * п.29: иконки для мобильного ряда действий. Inline-SVG вместо текстовых
 * глифов («☎», «●»): шрифт мог подставить чужой символ или квадратик.
 * Все рисунки наследуют цвет текста через currentColor.
 */
function IconPhone() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5Z" />
    </svg>
  );
}

function IconMic() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="10" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
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

function ClientLoading() {
  return (
    <div className="mx-auto max-w-[1240px] space-y-4" aria-busy="true">
      <Skeleton className="h-24 rounded-card" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-20 rounded-card" />)}
      </div>
      <Skeleton className="h-64 rounded-card" />
    </div>
  );
}

export default function ClientPage() {
  return <Suspense fallback={<ClientLoading />}><ClientWorkspace /></Suspense>;
}

function ClientWorkspace() {
  const { id: clientId } = useParams<{ id: string }>();
  const selectedTab = useSearchParams().get("tab") as Tab | null;
  const urlTab = selectedTab && TAB_KEYS.includes(selectedTab) ? selectedTab : "overview";
  const [tab, setActiveTab] = useState<Tab>(urlTab);

  useLayoutEffect(() => {
    setActiveTab(urlTab);
  }, [clientId, urlTab]);

  const [client, setClient] = useState<ClientDetail | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [budgetProject, setBudgetProject] = useState<Project | null>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [finance, setFinance] = useState<FinancialSummary | null>(null);
  const [financeEntry, setFinanceEntry] = useState<"invoice" | "payment" | null>(null);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [contracts, setContracts] = useState<ClientContract[]>([]);
  // п.15: счета нужны для выбора при создании договора.
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [contractOpen, setContractOpen] = useState(false);
  const [history, setHistory] = useState<ClientHistoryEvent[]>([]);
  const [resolvedClientId, setResolvedClientId] = useState<string>();
  const loadRevision = useRef(0);
  const [createTask, setCreateTask] = useState(false);
  const [copiedContact, setCopiedContact] = useState("");
  const [historyFilter, setHistoryFilter] = useState("all");

  const setTab = useCallback((next: Tab) => {
    setActiveTab(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    url.hash = "";
    window.history.replaceState(null, "", url);
  }, []);

  useEffect(() => {
    if (resolvedClientId !== clientId) return;
    let frame: number;
    function scrollToRecord() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const id = window.location.hash.slice(1);
        if (id) document.getElementById(id)?.scrollIntoView({ block: "center" });
      });
    }
    scrollToRecord();
    window.addEventListener("hashchange", scrollToRecord);
    window.addEventListener("forteon:record-link", scrollToRecord);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", scrollToRecord);
      window.removeEventListener("forteon:record-link", scrollToRecord);
    };
  }, [tab, resolvedClientId, clientId]);
  const [error, setError] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
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
        entity: event.entity,
        title:
          HISTORY_RU[`${event.entity}:${event.action}`] ??
          `${event.entity}: ${event.action}`,
        tone: historyTone(event.entity, event.action),
        amount: historyAmount(event.metadata),
        actor: event.actor,
        moneyChanges: event.metadata?.money_changes as Record<string, { before: string | null; after: string | null }> | undefined,
      })),
    [history],
  );

  const visibleHistory = historyItems.filter((item) =>
    historyFilter === "all" || (historyFilter === "money" ? (MONEY_ENTITIES.has(item.entity) || Boolean(Object.keys(item.moneyChanges ?? {}).length)) : item.entity === historyFilter),
  );

  async function copyPhone(phone: string) {
    try {
      await navigator.clipboard.writeText(phone);
      setCopiedContact("Номер скопирован");
    } catch {
      setCopiedContact("Не удалось скопировать номер");
    }
  }

  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    try {
      const [
        detail, projectList, taskList, notePage, fin, docs,
        contractList, invoiceList, auditPage,
      ] =
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
          // Ошибка здесь не должна ломать карточку: договор можно завести
          // и без счёта, просто этот выбор будет недоступен.
          api<ClientInvoice[]>(`/clients/${clientId}/invoices`).catch(() => []),
          /*
           * A-P0-2: журнал аудита по клиенту. Ошибка здесь не должна ломать
           * карточку — остальные вкладки остаются работоспособными.
           */
          api<{ items: ClientHistoryEvent[] }>(`/clients/${clientId}/history?limit=100`)
            .catch(() => ({ items: [] })),
        ]);
      if (revision !== loadRevision.current) return;
      setClient(detail);
      setProjects(projectList);
      setTasks(taskList.items);
      setNotes(Array.isArray(notePage) ? notePage : notePage?.items ?? []);
      setFinance(fin);
      setDocuments(Array.isArray(docs) ? docs : []);
      setContracts(Array.isArray(contractList) ? contractList : []);
      setInvoices(Array.isArray(invoiceList) ? invoiceList : []);
      setHistory(Array.isArray(auditPage?.items) ? auditPage.items : []);
      setError(null);
    } catch (err) {
      if (revision === loadRevision.current) {
        setError(err instanceof Error ? err.message : "Не удалось загрузить карточку клиента");
      }
    } finally {
      if (revision === loadRevision.current) setResolvedClientId(clientId);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
    return () => { loadRevision.current += 1; };
  }, [load]);

  /**
   * п.1–5 «30 идей»: заметку создаёт единая форма VoiceNoteForm.
   * Она сама держит черновик и ключ идемпотентности, поэтому здесь
   * достаточно отправить запрос и перечитать карточку.
   */
  const createNote = useCallback(
    async ({
      body,
      sourceType,
      idempotencyKey,
    }: {
      body: string;
      sourceType: "text" | "voice";
      idempotencyKey: string;
    }) => {
      const note = await api<Note>(`/clients/${clientId}/notes`, {
        method: "POST",
        body: {
          body,
          run_ai: true,
          source_type: sourceType,
          idempotency_key: idempotencyKey,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      });
      setNoteOpen(false);
      await load();
      setTab("notes");
      return note.id;
    },
    [clientId, load, setTab],
  );

  async function complete(taskId: string) {
    await api(`/tasks/${taskId}/complete`, { method: "POST", body: {} });
    await load();
  }

  if (resolvedClientId !== clientId) return <ClientLoading />;

  if (!client || client.id !== clientId) {
    return (
      <Card>
        <EmptyState
          title="Клиент недоступен"
          description={error ?? "Клиент не найден или принадлежит другому менеджеру."}
          action={
            <Link href="/clients" className="font-medium text-primary hover:underline">К списку клиентов</Link>
          }
        />
      </Card>
    );
  }

  const openTasks = tasks.filter((t) => t.status === "open");
  const overdue = openTasks.filter((t) => isOverdue(t));
  const nextStep = [...openTasks].filter((task) => task.actor !== "client").sort((a, b) =>
    (a.due_date ?? "9999-12-31").localeCompare(b.due_date ?? "9999-12-31"),
  )[0];

  /*
   * п.29 «30 идей»: на телефоне из карточки должны быть доступны три главных
   * действия одной рукой — позвонить, надиктовать, поставить задачу.
   * Номер берём у основного контакта, иначе у первого, у кого он вообще есть:
   * иначе кнопка «Позвонить» вела бы в пустоту.
   */
  const callContact =
    client.contacts.find((contact) => contact.is_primary && contact.phone) ??
    client.contacts.find((contact) => Boolean(contact.phone));
  const callHref = callContact?.phone
    ? `tel:${callContact.phone.replace(/[^+\d]/g, "")}`
    : "";

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <nav className="flex items-center gap-1.5 text-[12.5px] text-[var(--muted)]">
        <Link href="/clients" className="inline-flex min-h-[44px] items-center hover:text-primary sm:min-h-0">
          Клиенты
        </Link>
        <span>/</span>
        <span className="truncate text-ink">{client.name}</span>
      </nav>

      {error && <p role="alert" className="rounded-control bg-[var(--danger-soft)] p-3 text-sm text-[var(--danger)]">{error}</p>}
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
            {/*
              п.29: на телефоне три главных действия — сразу под заголовком.
              На десктопе ряд скрыт: там те же действия справа в шапке.

              Вертикальная компоновка (иконка над словом), а не строка:
              при 390px на треть экрана приходится ~94px, и «Надиктовать»
              в строку упиралось в рамку. Плитка выше, но нажимается
              уверенно, и слово всегда целиком.

              Оформление взято из системы, а не своё: `forteon-action`
              даёт transition и просадку при нажатии (active:scale .98),
              `shadow-soft` — ту же тень, что у кнопок, hover поднимает
              плитку на 2px. Иконка сидит в мягком круге, как аватар
              в шапке, — так плитка читается как действие, а не как текст
              в рамке. Появление — стаггером, чтобы ряд не «выскакивал».
            */}
            <div className="forteon-quick-actions mt-3 grid grid-cols-3 gap-2 sm:hidden">
              {callHref ? (
                <a
                  href={callHref}
                  className="forteon-action focus-ring group flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-card border border-[var(--border)] bg-surface px-1 py-2.5 shadow-soft transition-transform hover:-translate-y-0.5 hover:border-primary hover:shadow-lift active:translate-y-0"
                >
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--primary-soft)] text-primary transition-colors group-hover:bg-primary group-hover:text-white">
                    <IconPhone />
                  </span>
                  <span className="text-[12px] font-medium leading-none text-ink">Позвонить</span>
                </a>
              ) : (
                <button
                  type="button"
                  disabled
                  title="У клиента нет телефона в контактах"
                  className="flex min-h-[44px] cursor-not-allowed flex-col items-center justify-center gap-1.5 rounded-card border border-dashed border-[var(--border)] px-1 py-2.5"
                >
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--canvas)] text-[var(--muted)]">
                    <IconPhone />
                  </span>
                  <span className="text-[12px] font-medium leading-none text-[var(--muted)]">Позвонить</span>
                </button>
              )}
              <Link
                href={`/notes?client_id=${encodeURIComponent(clientId)}&voice=1`}
                className="forteon-action focus-ring group flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-card border border-[var(--border)] bg-surface px-1 py-2.5 shadow-soft transition-transform hover:-translate-y-0.5 hover:border-primary hover:shadow-lift active:translate-y-0"
              >
                <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--primary-soft)] text-primary transition-colors group-hover:bg-primary group-hover:text-white">
                  <IconMic />
                </span>
                <span className="text-[12px] font-medium leading-none text-ink">Голосом</span>
              </Link>
              <button
                type="button"
                onClick={() => setCreateTask(true)}
                className="forteon-action focus-ring group flex min-h-[44px] flex-col items-center justify-center gap-1.5 rounded-card bg-primary px-1 py-2.5 shadow-soft transition-transform hover:-translate-y-0.5 hover:bg-[var(--primary-hover)] hover:shadow-lift active:translate-y-0"
              >
                <span className="grid h-8 w-8 place-items-center rounded-full bg-white/20 text-white transition-colors group-hover:bg-white/30">
                  <IconPlus />
                </span>
                <span className="text-[12px] font-medium leading-none text-white">Задача</span>
              </button>
            </div>
          </div>
          <div className="hidden flex-wrap gap-2 sm:flex">
            <Link href={`/notes?client_id=${encodeURIComponent(clientId)}&voice=1`}
              className="focus-ring inline-flex h-11 items-center rounded-control border border-[var(--border-strong)] px-4 text-sm font-medium text-ink hover:text-primary">
              Записать голосом
            </Link>
            <Button variant="outline" onClick={() => setNoteOpen(true)}>Добавить заметку</Button>
            <Button onClick={() => setCreateTask(true)}>Поставить задачу</Button>
          </div>
        </div>
      </Card>

      {createTask && (
        <CreateTaskModal initialClient={client} initialDate="" onClose={() => setCreateTask(false)}
          onCreated={() => { setCreateTask(false); setTab("tasks"); void load(); }} />
      )}

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
        className="sticky top-[68px] z-10 -mx-4 flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--canvas)]/95 px-4 backdrop-blur md:mx-0 md:px-0"
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
        <div className="forteon-tab-panel grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <Card>
              <SectionTitle title="Следующий шаг" />
              {nextStep ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-ink">{nextStep.title}</p>
                    <p className="text-xs text-[var(--muted)]">{nextStep.due_date ? dateRu(nextStep.due_date) : "Без срока"}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => void chat.open(nextStep.id)}>Открыть задачу</Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setCreateTask(true)}>Назначить следующий шаг</Button>
              )}
            </Card>
            <Card>
              <SectionTitle title="Что требует внимания" subtitle="Просрочки и задачи на уточнении" />
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
                    <li key={contact.id} id={`contact-${contact.id}`} className="rounded-control border border-[var(--border)] px-3 py-2 target:ring-2 target:ring-primary">
                      <p className="text-[13px] font-medium text-ink">{contact.name}</p>
                      <p className="text-[11.5px] text-[var(--muted)]">
                        {[contact.position, contact.is_primary ? "Основной контакт" : null].filter(Boolean).join(" · ")}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-3 text-sm">
                        {contact.phone && (
                          <a className="focus-ring inline-flex min-h-11 items-center tabular text-primary"
                            href={`tel:${contact.phone.replace(/[^+\d]/g, "")}`}>{contact.phone}</a>
                        )}
                        {/* п.16: действия рядом с контактом, а не «найди номер и скопируй» */}
                        {contact.phone && (
                          <Button variant="ghost" size="sm" type="button" onClick={() => void copyPhone(contact.phone!)}>
                            Копировать
                          </Button>
                        )}
                        {contact.email && (
                          <a className="focus-ring inline-flex min-h-11 items-center break-all text-primary"
                            href={`mailto:${contact.email}`}>{contact.email}</a>
                        )}
                        {contact.email && (
                          <a
                            className="focus-ring inline-flex min-h-11 items-center text-[12.5px] font-medium text-primary hover:underline"
                            href={`mailto:${contact.email}?subject=${encodeURIComponent(`ForteOn: ${client.name}`)}`}
                          >
                            Написать
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-[var(--muted)]">Контакты не добавлены.</p>
              )}
              <p role="status" className="text-xs text-[var(--muted)]">{copiedContact}</p>
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
        <Card className="forteon-tab-panel">
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
        <Card className="forteon-tab-panel">
          <SectionTitle title="Задачи клиента" subtitle={`${tasks.length} всего, ${openTasks.length} открыто`} />
          {tasks.length ? (
            <div className="-mx-1">
              {tasks.map((task) => (
                <div key={task.id} id={`task-${task.id}`} className="rounded-control target:ring-2 target:ring-primary">
                  <TaskRow task={task} onComplete={task.status === "open" ? complete : undefined} />
                </div>
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
        <div className="forteon-tab-panel grid gap-4 lg:grid-cols-[1fr_1.2fr]">
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
            <SectionTitle title="Счета и поступления" />
            <p className="mb-3 text-sm leading-relaxed text-[var(--muted)]">
              {finance && finance.invoices === 0 ? "У клиента пока нет счетов. " : ""}
              Чтобы оплата уменьшила долг, при записи выберите счёт.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => setFinanceEntry("invoice")}>Добавить счёт</Button>
              <Button type="button" variant="outline" onClick={() => setFinanceEntry("payment")}>Записать оплату</Button>
            </div>
          </Card>
        </div>
      )}

      {tab === "projects" && (
        <div className="forteon-tab-panel space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-ink">Проекты клиента</h2>
            <Button type="button" onClick={() => setBudgetProject(null)}>Добавить проект</Button>
          </div>
          {projects.length ? (
            projects.map((project) => (
              <Card key={project.id} id={`project-${project.id}`} className="target:ring-2 target:ring-primary">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-[15px] font-semibold text-ink">{project.name}</h3>
                    <p className="text-[12px] text-[var(--muted)]">
                      {project.location || "—"} · получен {dateRu(project.start_date)}
                      {project.stage_group ? ` · ${project.stage_group}` : ""}
                    </p>
                    {/* п.14: сразу видно, откуда проект — из файла или заведён здесь */}
                    <p className="mt-0.5 text-[11.5px] text-[var(--muted)]">
                      {project.source_row
                        ? `Из отчёта, строка ${project.source_row}`
                        : "Заведён в системе"}
                    </p>
                    {project.email && (
                      <Link href={`/mail?to=${encodeURIComponent(project.email)}`}
                        className="text-sm text-primary hover:underline">{project.email}</Link>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={project.status} />
                    <Button type="button" size="sm" variant="outline" onClick={() => setBudgetProject(project)}>Изменить</Button>
                  </div>
                </div>
                <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="min-w-0 rounded-control border border-[var(--border)] bg-canvas px-3 py-2.5">
                    <dt className="text-[13px] text-[var(--muted)]">Плановый доход</dt>
                    <dd className="tabular mt-0.5 text-[15px] font-semibold text-ink">{project.planned_revenue == null ? "Не указан" : money(project.planned_revenue)}</dd>
                  </div>
                  <div className="min-w-0 rounded-control border border-[var(--border)] bg-canvas px-3 py-2.5">
                    <dt className="text-[13px] text-[var(--muted)]">Ожидаемая прибыль</dt>
                    <dd className="tabular mt-0.5 text-[15px] font-semibold text-ink">{project.expected_profit == null ? "Нужны доход и оценка затрат" : money(project.expected_profit)}</dd>
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
                <ProjectProvenanceBlock projectId={project.id} />
              </Card>
            ))
          ) : (
            <Card>
              <EmptyState title="Проектов нет" description="Добавьте проект и укажите доход и затраты, когда они известны." />
            </Card>
          )}

          {/* Пункт 37 + п.15: внутри проектов — договоры со счётом и файлом */}
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <SectionTitle
                title="Договоры"
                subtitle="Сумма договора не равна оплате — оплата видна по счёту"
              />
              <Button type="button" size="sm" variant="outline" onClick={() => setContractOpen(true)}>
                Добавить договор
              </Button>
            </div>
            {contracts.length ? (
              <div className="divide-y divide-[var(--border)]">
                {contracts.map((contract) => (
                  <div key={contract.id} id={`contract-${contract.id}`} className="py-2.5 target:ring-2 target:ring-primary">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-words text-[13.5px] font-medium text-ink">
                          {contract.number ? `Договор №${contract.number}` : "Без номера"}
                        </p>
                        <p className="text-[12px] text-[var(--muted)]">
                          подписан {dateRu(contract.signed_at)}
                          {contract.project_id
                            ? ` · ${projects.find((p) => p.id === contract.project_id)?.name ?? "проект"}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {contract.amount !== null && (
                          <span className="tabular text-[13px] font-medium text-ink">
                            {money(contract.amount, contract.currency)}
                          </span>
                        )}
                        <Badge tone="neutral">{contract.status}</Badge>
                      </div>
                    </div>
                    {/* п.15: счёт и оплата, иначе непонятно, закрыт ли договор */}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                      {contract.invoice_id ? (
                        <>
                          <span className="text-[var(--muted)]">
                            Счёт №{contract.invoice_number}
                          </span>
                          <span
                            className={
                              (contract.invoice_paid ?? 0) > 0
                                ? "text-[var(--success)]"
                                : "text-[var(--muted)]"
                            }
                          >
                            зачтено {money(contract.invoice_paid ?? 0, contract.currency)}
                            {contract.amount
                              ? ` из ${money(contract.amount, contract.currency)}`
                              : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-[var(--muted)]">Счёт не привязан</span>
                      )}
                    </div>
                    {/* Подписанные файлы договора */}
                    {contract.documents && contract.documents.length > 0 && (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {contract.documents.map((doc) => (
                          <li key={doc.id}>
                            <a
                              href={`${API_ROOT}/api/v1/documents/${doc.id}/download`}
                              className="focus-ring inline-flex max-w-[260px] items-center gap-1 rounded-lg border border-[var(--border)] bg-canvas px-2 py-1 text-[11.5px] text-ink hover:bg-[var(--primary-soft)]"
                              target="_blank"
                              rel="noreferrer"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                                <path d="M14 3v5h5" />
                              </svg>
                              <span className="truncate">{doc.filename}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-[12.5px] text-[var(--muted)]">
                Договоров пока нет. Добавьте номер, сумму и при желании счёт —
                по нему сразу будет видно, сколько уже зачтено.
              </p>
            )}
          </Card>
        </div>
      )}

      {/* ------------------------------------------------ Документы (п.39) */}
      {tab === "documents" && (
        <Card padded={false} className="forteon-tab-panel">
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
                <div key={doc.id} id={`document-${doc.id}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5 target:ring-2 target:ring-primary">
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
        <Card className="forteon-tab-panel">
          <SectionTitle
            title="История"
            subtitle="Журнал действий по клиенту: счета и оплаты, задачи, изменения карточки"
          />
          <Field
            label="События"
            hint={
              visibleHistory.length
                ? `Показано ${visibleHistory.length} из ${historyItems.length}`
                : undefined
            }
          >
            <select className={inputClass} value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)}>
              <option value="all">Все</option>
              <option value="money">Деньги: счета, оплаты, зачёты</option>
              <option value="task">Задачи</option>
              <option value="project">Проекты</option>
              <option value="contract">Договоры</option>
              <option value="document">Документы</option>
              <option value="client">Карточка клиента</option>
              <option value="note">Заметки</option>
            </select>
          </Field>
          {visibleHistory.length ? (
            <ol className="relative space-y-3 border-l border-[var(--border)] pl-4">
              {visibleHistory.map((item, index) => (
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
                  {Object.entries(item.moneyChanges ?? {}).map(([field, change]) => (
                    <p key={field} className="text-sm text-[var(--muted)]">
                      {field === "planned_revenue" ? "Плановая выручка" : "Ожидаемые затраты"} {money(change.before === null ? null : Number(change.before))} → {money(change.after === null ? null : Number(change.after))}
                    </p>
                  ))}
                  <p className="mt-0.5 text-[11.5px] text-[var(--muted)]">
                    {dateTimeRu(item.at)}
                    {item.actor ? ` · ${item.actor}` : ""}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState
              title={historyFilter === "all" ? "Событий пока нет" : "По этому фильтру событий нет"}
              description="Здесь появятся выставленные счета, поступившие оплаты, зачёты и изменения по задачам."
            />
          )}
        </Card>
      )}

      {financeEntry && (
        <ClientFinanceEntry clientId={clientId} kind={financeEntry} onClose={() => setFinanceEntry(null)}
          onSaved={() => { setFinanceEntry(null); void load(); }}
        />
      )}
      {contractOpen && (
        <ContractModal
          clientId={clientId}
          projects={projects}
          invoices={invoices}
          documents={documents}
          onClose={() => setContractOpen(false)}
          onSaved={(contract) => {
            setContracts((current) =>
              current.some((item) => item.id === contract.id)
                ? current.map((item) => (item.id === contract.id ? contract : item))
                : [contract, ...current],
            );
            setContractOpen(false);
            void load();
          }}
        />
      )}
      {budgetProject !== undefined && (
        <ProjectBudgetModal clientId={clientId} project={budgetProject} onClose={() => setBudgetProject(undefined)}
          onSaved={(project) => {
            setProjects((current) => current.some((item) => item.id === project.id)
              ? current.map((item) => item.id === project.id ? project : item)
              : [...current, project]);
            setBudgetProject(undefined);
            void load();
          }}
        />
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
      >
        <VoiceNoteForm
          client={client ? { id: clientId, name: client.name } : null}
          onSubmit={createNote}
          submitLabel="Сохранить и извлечь задачи"
        />
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

/**
 * п.14 «30 идей»: откуда взялись важные поля проекта.
 *
 * Загружается по требованию: менеджеру в 90% случаев история не нужна,
 * а лишний запрос на каждый проект замедляет вкладку. Поэтому сначала
 * подпись «из отчёта, строка N», а история — по клику.
 */
function ProjectProvenanceBlock({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProjectProvenance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (data || loading) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api<ProjectProvenance>(`/projects/${projectId}/provenance`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить историю");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 border-t border-[var(--border)] pt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        className="text-[11.5px] font-medium text-primary hover:underline"
        aria-expanded={open}
      >
        {open ? "Скрыть историю полей" : "Откуда эти цифры"}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {loading && <p className="text-[11.5px] text-[var(--muted)]">Загружаем историю…</p>}
          {error && <p className="text-[11.5px] text-[var(--danger)]">{error}</p>}
          {data && (
            <>
              <p className="text-[11.5px] text-[var(--muted)]">
                {data.origin === "import"
                  ? `Проект из отчёта, строка ${data.source_row}.`
                  : "Проект заведён в системе."}
                {data.created_by ? ` Завёл: ${data.created_by}.` : ""}
              </p>
              {data.entries.length ? (
                <ul className="space-y-1">
                  {data.entries.map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className="text-[11.5px] text-ink">
                      <span className="text-[var(--muted)]">{dateTimeRu(entry.at)}</span>
                      {" · "}
                      {entry.detail}
                      {entry.before || entry.after ? (
                        <span className="tabular text-[var(--muted)]">
                          {" "}
                          {money(entry.before === null ? null : Number(entry.before))} →{" "}
                          {money(entry.after === null ? null : Number(entry.after))}
                        </span>
                      ) : null}
                      {entry.actor ? <span className="text-[var(--muted)]"> · {entry.actor}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[11.5px] text-[var(--muted)]">Изменений ещё не было.</p>
              )}
            </>
          )}
        </div>
      )}
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
