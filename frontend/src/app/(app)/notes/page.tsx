"use client";

/**
 * Заметки — §5 (46–64).
 *
 * Компоновка по гайду: слева поиск клиента, в центре лента, снизу
 * закреплённый редактор. Менеджер пишет обычным текстом, система сама
 * находит сроки и обязательства.
 *
 * Что важно и зачем:
 *  - заметка появляется в ленте сразу, со статусом «Анализируется»
 *    (п.56: не заставляем ждать ответа сервера);
 *  - у каждой созданной задачи есть «Почему создана?» с цитатой из
 *    заметки (п.57) — менеджер видит, из какой фразы родилось действие;
 *  - если срок не определён — чип «Уточнить срок» (п.58);
 *  - при ошибке AI текст не пропадает, есть «Повторить разбор» и
 *    «Исправить текст» (п.61–62);
 *  - менеджер никогда не видит ai_status как код и не видит JSON (п.63):
 *    только человеческие формулировки;
 *  - выбранный клиент восстанавливается (п.60).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  ReviewChip,
  SectionTitle,
  Skeleton,
} from "@/components/ui";
import { VoiceNoteForm } from "@/components/VoiceNoteForm";
import { api, API_ROOT, ExtractionSummary, getToken, Note } from "@/lib/api";
import { PRIORITY_LABELS, dateTimeRu, formatBytes, isOverdue, relativeDay } from "@/lib/format";

type PickerClient = {
  id: string;
  name: string;
  status: string;
  last_note_at: string | null;
  open_tasks: number;
  score: number;
};

/** Задача, которую AI вытащил из заметки (приходит вместе с лентой). */
type NoteTask = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_at: string | null;
  priority: string;
  type: string;
  source_quote: string | null;
  needs_review: boolean;
  /** P0 AI Task Extraction 2.0 (см. lib/api.ts). */
  event_kind?: "done" | "todo" | "waiting" | "unclear";
  actor?: "us" | "client";
  review_question?: string | null;
};

type NoteCommitment = {
  description: string;
  promised_by: string;
  due_date: string | null;
  source_quote: string | null;
};

/*
 * `Note.tasks` объявлен как короткий перечень {title, status} для карточки
 * клиента. Лента отдаёт расширенные задачи, поэтому заменяем поле через
 * Omit — иначе пересечение типов даёт NoteTaskRef & NoteTask.
 */
type FeedNote = Omit<Note, "tasks"> & {
  tasks?: NoteTask[];
  commitments?: NoteCommitment[];
  task_count?: number;
  open_task_count?: number;
  /** Итог разбора одной строкой — приходит из ленты (п.2 «30 идей»). */
  summary?: ExtractionSummary;
  /** Локальная запись, которую ещё не подтвердил сервер (п.56). */
  optimistic?: boolean;
  /**
   * п.18–19: кто реально обработал заметку.
   * model = "local-rules" — AI не настроен; "local-rules-fallback" — AI упал.
   */
  model?: string | null;
  used_fallback?: boolean;
  provider_note?: string | null;
};

/*
 * Диктовка, черновик и аудио живут в VoiceNoteForm (п.1–5 «30 идей»).
 * Здесь остаётся только лента и выбор клиента — дублировать распознавание
 * речи на странице больше не нужно.
 */
type UploadedFile = { name: string; size: number };

const PAGE_SIZE = 20;
const STORE_CLIENT = "forteon.notes.client";

/** «Общались сегодня» / «12 дней назад» — понятнее, чем дата. */
function freshness(iso: string | null): string {
  if (!iso) return "ещё не общались";
  return relativeDay(iso).replace("Сегодня", "сегодня").replace("Завтра", "завтра");
}

/** Человеческая формулировка состояния разбора — без кодов (п.63). */
function aiState(note: FeedNote): { tone: "warning" | "danger" | "neutral"; label: string } | null {
  if (note.optimistic) return { tone: "warning", label: "Анализируется" };
  if (note.ai_status === "pending" || note.ai_status === "queued") {
    return { tone: "warning", label: "Анализируется" };
  }
  if (note.ai_status === "failed") return { tone: "danger", label: "Не удалось разобрать" };
  if (note.ai_status === "skipped") return { tone: "neutral", label: "Сохранено без разбора" };
  return null;
}

export default function NotesPage() {
  /* ---------------------------------------------------------- состояние */
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState<PickerClient[]>([]);
  const [clientFilter, setClientFilter] = useState<{ id: string; name: string } | null>(null);
  const [notes, setNotes] = useState<FeedNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [uploads, setUploads] = useState<UploadedFile[]>([]);
  /** Если правим текст уже сохранённой заметки — держим её id (п.62). */
  const [correcting, setCorrecting] = useState<string | null>(null);
  /** Исходный текст правимой заметки — из него форма берёт значение. */
  const [correctingText, setCorrectingText] = useState("");
  const [mobileStep, setMobileStep] = useState<"pick" | "write">("pick");

  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  /* ------------------------------------------------------------ запросы */
  const fetchPicker = useCallback(async (q: string): Promise<PickerClient[]> => {
    const res = await api<{ items: PickerClient[] }>(
      `/clients/picker?limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    );
    return res.items;
  }, []);

  const feedUrl = useCallback(
    (limit: number, before?: string | null) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (clientFilter) params.set("client_id", clientFilter.id);
      if (before) params.set("before", before);
      return `/notes/feed?${params.toString()}`;
    },
    [clientFilter],
  );

  const loadFirstPage = useCallback(async () => {
    setFeedError(null);
    try {
      const data = await api<{
        items: FeedNote[];
        next_before: string | null;
        has_more: boolean;
      }>(feedUrl(PAGE_SIZE));
      setNotes(data.items);
      setNextBefore(data.next_before);
      setHasMore(Boolean(data.has_more) && Boolean(data.next_before));
    } catch (err) {
      setFeedError(err instanceof Error ? err.message : "Не удалось загрузить ленту");
    }
  }, [feedUrl]);

  const loadOlder: () => Promise<void> = useCallback(async () => {
    if (!nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const data = await api<{
        items: FeedNote[];
        next_before: string | null;
        has_more: boolean;
      }>(feedUrl(PAGE_SIZE, nextBefore));
      setNotes((prev) => {
        const seen = new Set(prev.map((n) => n.id));
        return [...prev, ...data.items.filter((n) => !seen.has(n.id))];
      });
      setNextBefore(data.next_before);
      setHasMore(Boolean(data.has_more) && Boolean(data.next_before));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить более ранние заметки");
    } finally {
      setLoadingOlder(false);
    }
  }, [feedUrl, nextBefore, loadingOlder]);

  /* ------------------------------------------------------- первый рендер */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const items = await fetchPicker("");
        if (cancelled) return;
        setPicker(items);
        // Восстанавливаем клиента, с которым работали в прошлый раз (п.60)
        const storedId =
          typeof window !== "undefined" ? window.localStorage.getItem(STORE_CLIENT) : null;
        const restored = storedId ? items.find((c) => c.id === storedId) : undefined;
        if (restored) {
          setClientFilter({ id: restored.id, name: restored.name });
          setMobileStep("write");
        }
      } catch {
        if (!cancelled) setPicker([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchPicker]);

  // Лента грузится после того, как определились с фильтром клиента
  useEffect(() => {
    if (loading) return;
    void loadFirstPage();
  }, [loading, loadFirstPage]);

  useEffect(() => {
    if (loading || window.matchMedia("(min-width: 1024px)").matches) return;
    window.scrollTo({ top: 0 });
  }, [loading, mobileStep]);

  // Поиск клиента с задержкой, чтобы не дёргать сервер на каждую букву
  useEffect(() => {
    let cancelled = false;
    setPickerLoading(true);
    const id = setTimeout(async () => {
      try {
        const items = await fetchPicker(query.trim());
        if (!cancelled) setPicker(items);
      } catch {
        if (!cancelled) setPicker([]);
      } finally {
        if (!cancelled) setPickerLoading(false);
      }
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query, fetchPicker]);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, []);

  /* ------------------------------------------------------------- выбор */
  const chooseClient = useCallback((client: { id: string; name: string } | null) => {
    setClientFilter(client);
    try {
      if (client) window.localStorage.setItem(STORE_CLIENT, client.id);
      else window.localStorage.removeItem(STORE_CLIENT);
    } catch {
      /* приватный режим */
    }
    setMobileStep(client ? "write" : "pick");
  }, []);

  /* -------------------------------------------------- ожидание разбора AI */
  const pollNote = useCallback(
    (noteId: string) => {
      let attempts = 0;
      const tick = async () => {
        attempts += 1;
        try {
          const status = await api<{ ai_status: string }>(`/notes/${noteId}/ai-status`);
          if (status.ai_status !== "pending" && status.ai_status !== "queued") {
            await loadFirstPage();
            return;
          }
        } catch {
          /* один сбой не должен ломать ожидание */
        }
        if (attempts < 12) {
          pollRef.current = window.setTimeout(tick, 1000);
        }
      };
      pollRef.current = window.setTimeout(tick, 900);
    },
    [loadFirstPage],
  );

  /* ----------------------------------------------------------- отправка */
  /**
   * п.1–5 «30 идей»: отправку вызывает единая форма VoiceNoteForm.
   * Она держит текст, черновик и ключ идемпотентности, а здесь остаётся
   * только работа с сервером и лентой.
   *
   * Возвращаем id заметки: по нему форма понимает, что можно чистить
   * черновик, а страница — что пора ждать разбор AI.
   */
  const submitNote = useCallback(
    async ({
      body: text,
      sourceType,
      idempotencyKey,
    }: {
      body: string;
      sourceType: "text" | "voice";
      idempotencyKey: string;
    }): Promise<string | null> => {
      const target = clientFilter;
      if (!target) throw new Error("Сначала выберите клиента");

      // Исправление уже сохранённой заметки: PATCH, затем повторный разбор (п.62)
      if (correcting) {
        await api(`/notes/${correcting}`, { method: "PATCH", body: { body: text } });
        await api(`/notes/${correcting}/reprocess`, { method: "POST" });
        const id = correcting;
        setCorrecting(null);
        setCorrectingText("");
        setNotes((prev) =>
          prev.map((n) => (n.id === id ? { ...n, body: text, ai_status: "pending" } : n)),
        );
        pollNote(id);
        return id;
      }

      const tempId = `temp-${Date.now()}`;
      const optimistic: FeedNote = {
        id: tempId,
        client_id: target.id,
        project_id: null,
        body: text,
        source_type: sourceType,
        ai_status: "pending",
        ai_error: null,
        created_at: new Date().toISOString(),
        version: 1,
        client_name: target.name,
        tasks: [],
        commitments: [],
        optimistic: true,
      };
      // Заметка видна сразу, ещё до ответа сервера (п.56)
      setNotes((prev) => [optimistic, ...prev]);
      setUploads([]);

      try {
        const note = await api<Note>(`/clients/${target.id}/notes`, {
          method: "POST",
          body: {
            body: text,
            run_ai: true,
            source_type: sourceType,
            idempotency_key: idempotencyKey,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        });
        setNotes((prev) =>
          prev.map((n) =>
            n.id === tempId
              ? { ...n, id: note.id, created_at: note.created_at, optimistic: false }
              : n,
          ),
        );
        pollNote(note.id);
        try {
          const items = await fetchPicker("");
          setPicker(items);
        } catch {
          /* список клиентов не критичен */
        }
        return note.id;
      } catch (err) {
        // Убираем пустышку: текст останется в форме и в черновике
        setNotes((prev) => prev.filter((n) => n.id !== tempId));
        throw err instanceof Error ? err : new Error("Заметка не сохранена");
      }
    },
    [clientFilter, correcting, fetchPicker, pollNote],
  );

  /* ------------------------------------------------- повторный разбор */
  const reprocess = useCallback(
    async (noteId: string) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, ai_status: "pending", ai_error: null } : n)),
      );
      try {
        await api(`/notes/${noteId}/reprocess`, { method: "POST" });
        pollNote(noteId);
      } catch (err) {
        setNotes((prev) =>
          prev.map((n) => (n.id === noteId ? { ...n, ai_status: "failed" } : n)),
        );
        setError(err instanceof Error ? err.message : "Не удалось повторить разбор");
      }
    },
    [pollNote],
  );

  const startCorrection = useCallback(
    (note: FeedNote) => {
      setCorrecting(note.id);
      setCorrectingText(note.body);
      if (note.client_id) chooseClient({ id: note.client_id, name: note.client_name || "Клиент" });
      setMobileStep("write");
    },
    [chooseClient],
  );

  /* ------------------------------------------------------------ вложения */
  async function attach(file: File) {
    if (!clientFilter) {
      setError("Чтобы прикрепить файл, выберите клиента.");
      return;
    }
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const token = getToken();
    try {
      const res = await fetch(
        `${API_ROOT}/api/v1/documents/uploads?client_id=${encodeURIComponent(clientFilter.id)}`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: form,
        },
      );
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.detail?.message || payload?.detail || "Файл не загружен");
      }
      setUploads((prev) => [...prev, { name: file.name, size: file.size }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прикрепить файл");
    }
  }

  /* -------------------------------------------------------- производные */
  const grouped = useMemo(() => {
    const today: FeedNote[] = [];
    const earlier: FeedNote[] = [];
    const now = new Date();
    for (const note of notes) {
      const created = new Date(note.created_at);
      const sameDay =
        created.getDate() === now.getDate() &&
        created.getMonth() === now.getMonth() &&
        created.getFullYear() === now.getFullYear();
      (sameDay ? today : earlier).push(note);
    }
    return { today, earlier };
  }, [notes]);

  const derivedCount = useMemo(
    () => notes.reduce((sum, note) => sum + (note.tasks?.length ?? 0), 0),
    [notes],
  );

  /* ------------------------------------------------------------- разметка */
  if (loading) {
    return (
      <div className="mx-auto max-w-[1280px] space-y-4">
        <Skeleton className="h-24 rounded-card" />
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <Skeleton className="h-[420px] rounded-card" />
          <Skeleton className="h-[520px] rounded-card" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] lg:flex lg:h-[calc(100dvh-124px)] lg:min-h-[36rem] lg:flex-col">
      <header className="mb-4 shrink-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.026em] text-ink sm:text-[28px]">
          Заметки
        </h1>
        <p className="mt-1 max-w-2xl text-[14.5px] leading-relaxed text-[var(--muted)]">
          Сохраняйте договорённости и создавайте задачи из заметок.
        </p>
      </header>

      <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* ------------------------------------------------ поиск клиента */}
        <aside className={`min-h-0 ${mobileStep === "write" ? "hidden lg:block" : ""}`}>
          <Card className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
            <SectionTitle title="Клиент" subtitle="Выберите клиента для заметки" />

            <div className="relative mb-2">
              <svg
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.6-3.6" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Название, ИНН, телефон, контакт"
                aria-label="Найти клиента"
                className="focus-ring h-11 w-full min-w-0 rounded-control border border-[var(--border-strong)] bg-surface pl-9 pr-9 text-[14.5px] text-ink"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Сбросить поиск"
                  className="focus-ring absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-[var(--muted)] hover:bg-[#f1f4f9]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            <div className="mb-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => chooseClient(null)}
                className={`focus-ring h-11 min-h-[44px] rounded-lg px-2.5 text-[12.5px] font-medium transition-colors sm:h-8 sm:min-h-8 ${
                  clientFilter
                    ? "bg-[#f1f4f9] text-[var(--muted)] hover:text-ink"
                    : "bg-primary text-white"
                }`}
              >
                Все клиенты
              </button>
              {clientFilter && (
                <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg bg-[var(--primary-soft)] px-2.5 text-[12.5px] font-medium text-primary">
                  <span className="truncate">{clientFilter.name}</span>
                </span>
              )}
            </div>

            {/* Мобильный второй шаг: лента доступна и без выбора клиента (п.64) */}
            <button
              type="button"
              onClick={() => setMobileStep("write")}
              className="focus-ring mb-2 flex h-11 w-full items-center justify-center gap-2 rounded-control bg-[var(--primary-soft)] text-[13.5px] font-medium text-primary lg:hidden"
            >
              Смотреть ленту заметок
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>

            <div className="space-y-0.5 rounded-control border border-[var(--border)] p-1.5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
              {pickerLoading && picker.length === 0 && (
                <div className="space-y-1.5 p-1">
                  <Skeleton className="h-11" />
                  <Skeleton className="h-11" />
                  <Skeleton className="h-11" />
                </div>
              )}
              {!pickerLoading && picker.length === 0 && (
                <p className="px-2 py-4 text-center text-[13px] text-[var(--muted)]">
                  Клиенты не найдены. Попробуйте другой запрос.
                </p>
              )}
              {picker.map((client) => {
                const active = clientFilter?.id === client.id;
                return (
                  <button
                    key={client.id}
                    type="button"
                    onClick={() => chooseClient({ id: client.id, name: client.name })}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left transition-colors ${
                      active
                        ? "bg-[var(--primary-soft)] ring-1 ring-[var(--primary)]"
                        : "hover:bg-[#f7f9fc]"
                    }`}
                  >
                    <span
                      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${
                        active ? "bg-[var(--primary)] text-white" : "bg-[#eef2f8] text-[var(--muted)]"
                      }`}
                    >
                      {client.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[14px] font-medium ${
                          active ? "text-primary" : "text-ink"
                        }`}
                      >
                        {client.name}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[var(--muted)]">
                        <span>{freshness(client.last_note_at)}</span>
                        {client.open_tasks > 0 && (
                          <span className="font-medium text-[var(--warning)]">
                            {client.open_tasks} в работе
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="mt-2 text-[11.5px] leading-snug text-[var(--muted)]">
              {query
                ? "Сначала совпадения в названии"
                : "Сначала те, с кем общались недавно"}
            </p>
          </Card>
        </aside>

        <div className={`min-h-0 min-w-0 lg:flex lg:flex-col ${mobileStep === "pick" ? "hidden" : ""}`}>
          {mobileStep === "write" && (
            <button
              type="button"
              onClick={() => setMobileStep("pick")}
              className="focus-ring mb-3 inline-flex h-10 items-center gap-1.5 rounded-control border border-[var(--border-strong)] px-3 text-[13.5px] font-medium text-ink lg:hidden"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              Выбрать клиента
            </button>
          )}

          {error && (
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2 rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13.5px] text-[var(--danger)]">
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


          {/* На телефоне редактор перед лентой, на десктопе закреплён под ней. */}
          <Card
            className="mb-4 shrink-0 border-[var(--border-strong)] shadow-[0_6px_24px_rgba(15,23,42,0.10)] lg:order-3 lg:mb-0 lg:mt-3"
            padded
          >
            {/*
              Вложения живут в левом слоте формы: так скрепка стоит в одной
              строке с микрофоном и «Отправить», а не отдельным блоком снизу.
            */}
            <VoiceNoteForm
              client={clientFilter}
              onSubmit={submitNote}
              onCreated={(noteId) => {
                setMobileStep("write");
                pollNote(noteId);
              }}
              label={correcting ? "Исправление заметки" : "Новая заметка"}
              submitLabel={correcting ? "Сохранить и разобрать" : "Отправить"}
              initialBody={correcting ? correctingText : ""}
              hideExamples={Boolean(correcting)}
              leftSlot={
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void attach(file);
                      e.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    title="Прикрепить файл"
                    aria-label="Прикрепить файл"
                    className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-control border border-[var(--border-strong)] text-[var(--muted)] transition-colors hover:border-primary hover:text-primary"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                      <path d="M21.4 11.05l-8.9 8.9a5.2 5.2 0 01-7.4-7.4l8.2-8.2a3.5 3.5 0 014.9 4.9l-8.2 8.2a1.8 1.8 0 01-2.5-2.5l7.5-7.5" />
                    </svg>
                  </button>
                </>
              }
              rightSlot={
                correcting ? (
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => {
                      setCorrecting(null);
                      setCorrectingText("");
                    }}
                  >
                    Отменить
                  </Button>
                ) : undefined
              }
            />

            {uploads.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {uploads.map((file, index) => (
                  <span
                    key={`${file.name}-${index}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#eef2f8] px-2.5 py-1 text-[11.5px] text-[var(--muted)]"
                  >
                    <span className="truncate">{file.name}</span>
                    <span className="shrink-0">{formatBytes(file.size)}</span>
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* ------------------------------------------------------- лента */}
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 lg:order-1 lg:shrink-0">
            <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">Лента</h2>
            <span className="text-[12.5px] text-[var(--muted)]">
              {notes.length > 0
                ? `Заметки: ${notes.length} · Задачи: ${derivedCount}`
                : null}
            </span>
          </div>

          <div aria-label="Лента заметок" className="min-h-0 lg:order-2 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2">
            {feedError ? (
              <ErrorState
                title="Лента не загрузилась"
                description={feedError}
                onRetry={() => void loadFirstPage()}
              />
            ) : notes.length === 0 ? (
              <EmptyState
                title={clientFilter ? "У этого клиента заметок нет" : "Заметок пока нет"}
                description={
                  clientFilter
                    ? "Создайте первую заметку для этого клиента."
                    : "Выберите клиента, чтобы создать заметку."
                }
              />
            ) : (
              <div className="space-y-2.5">
                {grouped.today.length > 0 && (
                  <p className="pt-1 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    Сегодня
                  </p>
                )}
                {grouped.today.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    onReprocess={reprocess}
                    onCorrect={startCorrection}
                  />
                ))}

                {grouped.earlier.length > 0 && (
                  <p className="pt-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    Ранее
                  </p>
                )}
                {grouped.earlier.map((note) => (
                  <NoteCard
                    key={note.id}
                    note={note}
                    onReprocess={reprocess}
                    onCorrect={startCorrection}
                  />
                ))}

                {hasMore && (
                  <div className="pt-1">
                    <Button
                      variant="outline"
                      size="md"
                      loading={loadingOlder}
                      onClick={() => void loadOlder()}
                      className="w-full"
                    >
                      Показать более ранние
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ карточка */

function NoteCard({
  note,
  onReprocess,
  onCorrect,
}: {
  note: FeedNote;
  onReprocess: (id: string) => void;
  onCorrect: (note: FeedNote) => void;
}) {
  const state = aiState(note);
  const tasks = note.tasks ?? [];
  const commitments = note.commitments ?? [];
  const realId = !note.optimistic;

  /*
    п.59: ИИ иногда формулирует задачу неточно. Менеджер должен исправить её
    прямо здесь, не уходя в карточку клиента и не открывая модальное окно.
    Правим через PATCH /tasks/{id} — тот же эндпоинт, что и везде.
  */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  /** п.23: решение по предложенной задаче — id задачи, которую сейчас решаем. */
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  async function saveTaskTitle(taskId: string) {
    const title = draftTitle.trim();
    if (!title) {
      setEditingId(null);
      return;
    }
    setSavingEdit(true);
    try {
      await api(`/tasks/${taskId}`, { method: "PATCH", body: { title } });
      if (taskId) {
        // Обновляем локально, чтобы не ждать перезагрузку всей ленты.
        const target = tasks.find((t) => t.id === taskId);
        if (target) target.title = title;
      }
      setEditingId(null);
    } finally {
      setSavingEdit(false);
    }
  }

  /**
   * п.23: менеджер принимает, правит или отклоняет предложенную задачу.
   *
   * Раньше единственным выходом было «Уточнить срок» без действий — задача
   * висела в списке, и убрать её было нельзя. Здесь же явное решение:
   *   accept — задача остаётся как есть, признак уточнения снимается;
   *   edit   — отправляем уточнённые поля (срок и/или формулировку);
   *   reject — задача мягко удаляется, в журнал пишется rejected_by_user.
   */
  async function decideReview(taskId: string, decision: "accept" | "edit" | "reject") {
    setReviewingId(taskId);
    setReviewError(null);
    try {
      const body: Record<string, unknown> = { decision };
      if (decision === "edit") {
        const title = draftTitle.trim();
        if (title) body.title = title;
      }
      await api(`/tasks/${taskId}/review`, { method: "POST", body });
      // Локально отражаем результат, не дожидаясь перезагрузки всей ленты.
      const target = tasks.find((t) => t.id === taskId);
      if (target) {
        if (decision === "reject") {
          target.status = "deleted";
        } else {
          if (decision === "edit" && body.title) target.title = String(body.title);
          target.needs_review = false;
          target.review_question = null;
        }
      }
      setEditingId(null);
      setDraftTitle("");
    } catch (err) {
      setReviewError(
        err instanceof Error ? err.message : "Не удалось применить решение по задаче",
      );
    } finally {
      setReviewingId(null);
    }
  }

  return (
    <article className="rounded-card border border-[var(--border)] bg-surface p-3.5 shadow-soft">
      <header className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          href={`/clients/${note.client_id}`}
          className="max-w-full truncate text-[13.5px] font-semibold text-ink hover:text-primary focus-ring rounded"
        >
          {note.client_name ?? "Клиент"}
        </Link>
        <span className="text-[12px] text-[var(--muted)]">{dateTimeRu(note.created_at)}</span>
        {note.source_type === "voice" && <Badge tone="neutral">голос</Badge>}
        {state && (
          <Badge tone={state.tone}>
            {state.label}
            {state.tone === "warning" && <span className="ml-0.5 animate-pulse">…</span>}
          </Badge>
        )}
        {/*
          п.18–19: менеджер должен понимать, кто реально разобрал заметку.
          Молчать про fallback нельзя: локальные правила слабее модели, и
          «почему задача странная» должно иметь видимую причину.
        */}
        {realId && note.model && (
          <span
            title={note.provider_note ?? undefined}
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] ${
              note.used_fallback
                ? "bg-[var(--warning-soft)] text-[var(--warning)]"
                : "bg-[var(--primary-soft)] text-primary"
            }`}
          >
            {note.used_fallback ? "локальные правила" : "AI"}
          </span>
        )}
      </header>

      {/*
        п.19: AI упал — говорим прямо и показываем причину, но задачи всё равно
        показываем: они пришли из локальных правил и работать с ними можно.
      */}
      {realId && note.used_fallback && note.model === "local-rules-fallback" && (
        <div className="mt-1.5 rounded-control bg-[var(--warning-soft)] px-2.5 py-2 break-words text-[13px] leading-snug text-[var(--warning)]">
          {note.provider_note ?? "Заметку обработали по локальным правилам."}
        </div>
      )}

      {/*
        п.2 «30 идей»: итог одной строкой. Менеджеру после диктовки нужен
        ответ «что из этого получилось», а не список сущностей. Числа
        считает сервер — здесь только показываем.
      */}
      {realId && note.summary?.has_details && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12.5px] font-medium text-primary">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="shrink-0"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span className="[overflow-wrap:anywhere]">{note.summary.headline}</span>
        </p>
      )}

      <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink [overflow-wrap:anywhere]">
        {note.body}
      </p>

      {/* Ошибка разбора: не код, а понятный текст + два действия (п.61–62) */}
      {note.ai_status === "failed" && realId && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-control bg-[var(--danger-soft)] px-2.5 py-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--danger)]">
            {/*
              Если задачи уже есть — они из предыдущего успешного разбора.
              Обещать «задачи не созданы» в этом случае было бы неправдой.
            */}
            {tasks.length > 0
              ? "Повторный разбор не удался. Задачи из предыдущего разбора сохранены."
              : "Разбор не удался — задачи не созданы. Заметка сохранена."}
          </span>
          <button
            type="button"
            onClick={() => onReprocess(note.id)}
            className="focus-ring h-8 rounded-lg border border-[var(--danger)] px-2.5 text-[12.5px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)] hover:text-white"
          >
            Повторить разбор
          </button>
          <button
            type="button"
            onClick={() => onCorrect(note)}
            className="focus-ring h-8 rounded-lg px-2.5 text-[12.5px] font-medium text-[var(--danger)] underline decoration-dotted"
          >
            Исправить текст
          </button>
        </div>
      )}

      {/* Сохранено без разбора — предлагаем разобрать, а не молчим */}
      {note.ai_status === "skipped" && realId && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-[var(--muted)]">Задачи не извлекались.</span>
          <button
            type="button"
            onClick={() => onReprocess(note.id)}
            className="focus-ring h-8 rounded-lg bg-[var(--primary-soft)] px-2.5 text-[12.5px] font-medium text-primary"
          >
            Разобрать
          </button>
        </div>
      )}

      {(tasks.length > 0 || commitments.length > 0) && (
        <div className="mt-2.5 space-y-1.5 border-t border-[var(--border)] pt-2.5">
          {tasks.map((task) => (
            <div key={task.id} className="rounded-control bg-[#f8fafd] px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    task.priority === "critical"
                      ? "bg-[var(--danger)]"
                      : task.priority === "high"
                        ? "bg-[var(--warning)]"
                        : "bg-primary"
                  }`}
                />
                {editingId === task.id ? (
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <input
                      autoFocus
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveTaskTitle(task.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="focus-ring min-w-0 flex-1 rounded-md border border-[var(--border-strong)] px-2 py-1 text-[13.5px]"
                      aria-label="Исправить формулировку задачи"
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      loading={savingEdit}
                      onClick={() => void saveTaskTitle(task.id)}
                    >
                      Сохранить
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Отмена
                    </Button>
                  </span>
                ) : (
                  <>
                    <span
                      className={`min-w-0 flex-1 break-words text-[13.5px] font-medium ${
                        task.status === "done" ? "text-[var(--muted)] line-through" : "text-ink"
                      }`}
                    >
                      {task.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(task.id);
                        setDraftTitle(task.title);
                      }}
                      title="Исправить формулировку задачи"
                      aria-label="Исправить формулировку задачи"
                      className="focus-ring shrink-0 rounded px-1.5 py-1 text-[11.5px] font-medium text-primary hover:bg-[var(--primary-soft)]"
                    >
                      Исправить
                    </button>
                  </>
                )}
                {task.due_date && (
                  <span
                    className={`shrink-0 text-[12px] ${
                      isOverdue({ due_date: task.due_date, status: task.status })
                        ? "font-medium text-[var(--danger)]"
                        : "text-[var(--muted)]"
                    }`}
                  >
                    до {relativeDay(`${task.due_date}T00:00:00Z`).toLowerCase()}
                  </span>
                )}
                {task.event_kind === "waiting" ? (
                  <span className="shrink-0 rounded-full bg-[#fff1d6] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[#8a6410]">
                    {task.actor === "client" ? "ждём клиента" : "ждём"}
                  </span>
                ) : null}
                {task.needs_review && <ReviewChip reason={task.review_question} />}
                <span className="shrink-0 text-[11.5px] text-[var(--muted)]">
                  {PRIORITY_LABELS[task.priority] ?? task.priority}
                </span>
              </div>

              {/* п.14: в уточнении должен быть понятный вопрос, а не «уточните» */}
              {task.needs_review && task.review_question && (
                <p className="mt-1 break-words text-[13px] leading-snug text-[var(--warning)]">
                  {task.review_question}
                </p>
              )}

              {/* п.23: решение по предложенной задаче — явными кнопками,
                  иначе задача навсегда висит в «Уточнить» */}
              {task.needs_review && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {editingId === task.id ? (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={reviewingId === task.id}
                      onClick={() => void decideReview(task.id, "edit")}
                    >
                      Сохранить и принять
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={reviewingId === task.id}
                      onClick={() => void decideReview(task.id, "accept")}
                    >
                      Принять
                    </Button>
                  )}
                  {editingId !== task.id && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingId(task.id);
                        setDraftTitle(task.title);
                      }}
                    >
                      Изменить
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={reviewingId === task.id}
                    onClick={() => void decideReview(task.id, "reject")}
                  >
                    Отклонить
                  </Button>
                </div>
              )}

              {task.needs_review && reviewError && (
                <p className="mt-1 text-[12px] text-[var(--danger)]">{reviewError}</p>
              )}

              {/* «Почему создана?» — цитата из заметки (п.17) */}
              <details className="mt-1">
                <summary className="cursor-pointer list-none text-[12px] font-medium text-primary hover:underline">
                  Почему создана?
                </summary>
                <p className="mt-1 rounded-md border-l-2 border-[var(--border-strong)] bg-white px-2 py-1 text-[12.5px] italic leading-snug text-[var(--muted)]">
                  {task.source_quote
                    ? `«${task.source_quote}»`
                    : "Цитата не сохранена — проверьте формулировку заметки."}
                </p>
              </details>
            </div>
          ))}

          {commitments.map((commitment, index) => (
            <div key={`${commitment.description}-${index}`} className="rounded-control bg-[#fffdf5] px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="rounded-full bg-[var(--warning-soft)] px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[#B45309]">
                  {commitment.promised_by === "us" ? "наше обещание" : "обещание клиента"}
                </span>
                <span className="min-w-0 flex-1 break-words text-[13px] text-ink">
                  {commitment.description}
                </span>
                {commitment.due_date && (
                  <span className="shrink-0 text-[12px] text-[var(--muted)]">
                    до {relativeDay(`${commitment.due_date}T00:00:00Z`).toLowerCase()}
                  </span>
                )}
              </div>
              {commitment.source_quote && (
                <p className="mt-1 border-l-2 border-[#e7d9a8] pl-2 text-[12px] italic leading-snug text-[var(--muted)]">
                  «{commitment.source_quote}»
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

