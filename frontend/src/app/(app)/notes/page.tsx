"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  SectionTitle,
  Skeleton,
  TaskRow,
  textareaClass,
} from "@/components/ui";
import { api, Note, Task } from "@/lib/api";
import { dateTimeRu, relativeDay } from "@/lib/format";

type PickerClient = {
  id: string;
  name: string;
  status: string;
  last_note_at: string | null;
  open_tasks: number;
  score: number;
};

type ClientNote = Note & { client_name?: string };

const EXAMPLES = [
  "Клиент просит КП до 25.11.2026, обещал оплату по счёту №214 до 05.12.2026.",
  "Позвонил, договорились о встрече в пятницу в 15:00 на объекте.",
  "Нужно переделать смету, замечания от 3 ноября. Срок — до конца месяца.",
];

/** «Общались сегодня» / «12 дней назад» — понятнее, чем дата. */
function freshness(iso: string | null): string {
  if (!iso) return "ещё не общались";
  return relativeDay(iso).replace("Сегодня", "сегодня").replace("Завтра", "завтра");
}

export default function NotesPage() {
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState<PickerClient[]>([]);
  const [selected, setSelected] = useState<PickerClient | null>(null);
  const [feed, setFeed] = useState<ClientNote[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTasks, setLastTasks] = useState<Task[]>([]);
  const [lastNoteId, setLastNoteId] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  const loadPicker = useCallback(async (q: string) => {
    setPickerLoading(true);
    try {
      const res = await api<{ items: PickerClient[] }>(
        `/clients/picker?limit=12${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      );
      setPicker(res.items);
      // Первый в списке выбирается автоматически только при пустом поиске
      setSelected((prev) => {
        if (prev && res.items.some((c) => c.id === prev.id)) {
          return res.items.find((c) => c.id === prev.id) ?? prev;
        }
        return q ? null : res.items[0] ?? null;
      });
    } catch {
      setPicker([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const loadFeed = useCallback(async () => {
    try {
      const data = await api<{ items: ClientNote[] }>("/notes/feed?limit=60");
      setFeed(data.items);
    } catch {
      setFeed([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await Promise.all([loadPicker(""), loadFeed()]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPicker, loadFeed]);

  // Поиск с задержкой, чтобы не дёргать сервер на каждую букву
  useEffect(() => {
    const id = setTimeout(() => void loadPicker(query.trim()), 260);
    return () => clearTimeout(id);
  }, [query, loadPicker]);

  async function save(runAi: boolean) {
    if (!selected || !body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const note = await api<Note>(`/clients/${selected.id}/notes`, {
        method: "POST",
        body: { body: body.trim(), run_ai: runAi, source_type: "text" },
      });
      setLastNoteId(note.id);
      setBody("");
      setLastTasks([]);
      await Promise.all([loadFeed(), loadPicker(query.trim())]);
      if (runAi) {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await new Promise((r) => setTimeout(r, 900));
          try {
            const tasks = await api<Task[]>(`/notes/${note.id}/tasks`);
            if (tasks.length) {
              setLastTasks(tasks);
              break;
            }
          } catch {
            /* ещё не готово */
          }
        }
      }
      areaRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить заметку");
    } finally {
      setSaving(false);
    }
  }

  async function complete(taskId: string) {
    await api(`/tasks/${taskId}/complete`, { method: "POST", body: { result_note: null } });
    setLastTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  const grouped = useMemo(() => {
    const today: ClientNote[] = [];
    const earlier: ClientNote[] = [];
    const now = new Date();
    for (const note of feed) {
      const created = new Date(note.created_at);
      const sameDay =
        created.getDate() === now.getDate() &&
        created.getMonth() === now.getMonth() &&
        created.getFullYear() === now.getFullYear();
      (sameDay ? today : earlier).push(note);
    }
    return { today, earlier };
  }, [feed]);

  if (loading) {
    return (
      <div className="mx-auto max-w-[1180px] space-y-4">
        <Skeleton className="h-28 rounded-card" />
        <Skeleton className="h-52 rounded-card" />
        <Skeleton className="h-72 rounded-card" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] space-y-5">
      <header>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.026em] text-ink">
          Заметки
        </h1>
        <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-[var(--muted)]">
          Пишите обычным текстом, как в мессенджере. Система сама найдёт сроки, обещания
          и создаст задачи.
        </p>
      </header>

      {error && (
        <div className="rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-4 py-3 text-[14px] text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Card>
            <SectionTitle
              title="Новая заметка"
              subtitle="Сначала выберите клиента, затем опишите ситуацию"
            />

            {/* Поиск клиента с релевантностью */}
            <div className="mb-3">
              <div className="relative">
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
                  placeholder="Найти клиента: имя, объект, юрлицо"
                  className="h-11 w-full rounded-control border border-[var(--border-strong)] bg-surface pl-9 pr-3 text-[14.5px] text-ink focus-ring"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    aria-label="Сбросить поиск"
                    className="absolute right-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-[var(--muted)] hover:bg-[#f1f4f9]"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <p className="mt-1.5 text-[12px] leading-snug text-[var(--muted)]">
                {query
                  ? "Сортировка: сначала совпадения в названии"
                  : "Сортировка: сначала те, с кем общались недавно, ниже — забытые"}
              </p>
            </div>

            {/* Список кандидатов */}
            {/*
              260px обрезали список посередине строки — четвёртый клиент
              был виден наполовину. Показываем все результаты поиска,
              прокрутка включается только когда их действительно много.
            */}
            <div className="mb-3 max-h-[420px] space-y-1 overflow-y-auto rounded-control border border-[var(--border)] p-1.5">
              {pickerLoading && picker.length === 0 && (
                <div className="space-y-1.5 p-1">
                  <Skeleton className="h-11" />
                  <Skeleton className="h-11" />
                  <Skeleton className="h-11" />
                </div>
              )}
              {!pickerLoading && picker.length === 0 && (
                <p className="px-2.5 py-4 text-center text-[13.5px] text-[var(--muted)]">
                  Ничего не найдено. Измените запрос.
                </p>
              )}
              {picker.map((client) => {
                const active = selected?.id === client.id;
                return (
                  <button
                    key={client.id}
                    onClick={() => setSelected(client)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors ${
                      active
                        ? "bg-[var(--primary-soft)] ring-1 ring-[var(--primary)]"
                        : "hover:bg-[#f7f9fc]"
                    }`}
                  >
                    <span
                      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold ${
                        active
                          ? "bg-[var(--primary)] text-white"
                          : "bg-[#eef2f8] text-[var(--muted)]"
                      }`}
                    >
                      {client.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[14.5px] font-medium ${
                          active ? "text-primary" : "text-ink"
                        }`}
                      >
                        {client.name}
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-[var(--muted)]">
                        <span>{freshness(client.last_note_at)}</span>
                        {client.open_tasks > 0 && (
                          <span className="font-medium text-[var(--warning)]">
                            {client.open_tasks} в работе
                          </span>
                        )}
                      </span>
                    </span>
                    {active && (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className="shrink-0 text-primary">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mb-3 flex items-center justify-between gap-2 rounded-control bg-[#f7f9fc] px-3 py-2">
              <span className="text-[13px] text-[var(--muted)]">Выбран клиент</span>
              <span className="truncate text-[13.5px] font-semibold text-ink">
                {selected ? selected.name : "не выбран"}
              </span>
            </div>

            <textarea
              ref={areaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="Например: Нужно отправить КП до 25.11.2026. Клиент обещал перевести оплату по счёту №214 до 05.12.2026."
              className={`${textareaClass} min-h-[148px] text-[15px] leading-relaxed`}
            />

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void save(true)}
                loading={saving}
                disabled={!body.trim() || !selected}
                size="lg"
              >
                Сохранить и разобрать
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={() => void save(false)}
                disabled={!body.trim() || !selected || saving}
              >
                Просто сохранить
              </Button>
              {body && (
                <Button variant="ghost" size="lg" onClick={() => setBody("")}>
                  Очистить
                </Button>
              )}
            </div>

            <div className="mt-4">
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]">
                Примеры — нажмите, чтобы подставить
              </p>
              <div className="space-y-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    onClick={() => {
                      setBody(example);
                      areaRef.current?.focus();
                    }}
                    className="block w-full rounded-lg border border-[var(--border)] px-3 py-2 text-left text-[13px] leading-snug text-ink transition-colors hover:border-primary hover:bg-[var(--primary-soft)] hover:text-primary focus-ring"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          {lastNoteId && (
            <Card className={lastTasks.length ? "border-[#c4e6d6]" : ""}>
              <SectionTitle
                title={lastTasks.length ? "AI нашёл задачи" : "AI обрабатывает заметку"}
                subtitle={
                  lastTasks.length
                    ? "Проверьте сроки — их можно изменить в планировщике"
                    : "Обычно это занимает несколько секунд"
                }
              />
              {lastTasks.length > 0 ? (
                <div className="space-y-1">
                  {lastTasks.map((task) => (
                    <TaskRow key={task.id} task={task} onComplete={complete} />
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2.5 rounded-control bg-[var(--primary-soft)] px-3 py-2.5 text-[13.5px] text-primary">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Извлекаем обязательства и сроки…
                </div>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {selected && (
            <Card>
              <SectionTitle title="Карточка клиента" subtitle={selected.name} />
              <dl className="mb-3 space-y-1.5 text-[13.5px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Последний контакт</dt>
                  <dd className="text-right text-ink">{freshness(selected.last_note_at)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--muted)]">Задач в работе</dt>
                  <dd className="text-right text-ink">{selected.open_tasks}</dd>
                </div>
              </dl>
              <Link
                href={`/clients/${selected.id}`}
                className="inline-flex h-10 items-center gap-2 rounded-control border border-[var(--border-strong)] px-3.5 text-[13.5px] font-medium text-ink transition-colors hover:border-primary hover:text-primary focus-ring"
              >
                Открыть полностью
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
            </Card>
          )}

          <Card>
            <SectionTitle title="Лента" subtitle="Новые сверху" />
            {feed.length === 0 ? (
              <EmptyState
                title="Заметок пока нет"
                description="Напишите первую — хотя бы одну фразу. Остальное система сделает сама."
              />
            ) : (
              <div className="max-h-[640px] space-y-3 overflow-y-auto pr-1">
                {grouped.today.length > 0 && (
                  <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    Сегодня
                  </p>
                )}
                {grouped.today.map((note) => (
                  <NoteCard key={note.id} note={note} />
                ))}
                {grouped.earlier.length > 0 && (
                  <p className="pt-1 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                    Ранее
                  </p>
                )}
                {grouped.earlier.map((note) => (
                  <NoteCard key={note.id} note={note} />
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function NoteCard({ note }: { note: ClientNote }) {
  const stateBadge =
    note.ai_status === "ok" ? (
      <Badge tone="success">разобрано</Badge>
    ) : note.ai_status === "failed" ? (
      <Badge tone="danger">ошибка</Badge>
    ) : note.ai_status === "pending" ? (
      <Badge tone="warning">в очереди</Badge>
    ) : (
      <Badge tone="neutral">без разбора</Badge>
    );

  return (
    <div className="rounded-control border border-[var(--border)] bg-[#fbfcfe] p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">
          {note.client_name ?? "Клиент"}
        </span>
        <span className="text-[12px] text-[var(--muted)]">{dateTimeRu(note.created_at)}</span>
        {stateBadge}
      </div>
      <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{note.body}</p>
    </div>
  );
}
