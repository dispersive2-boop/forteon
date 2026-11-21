"use client";

/**
 * Задача как чат — переиспользуемая карточка.
 *
 * Живёт в планировщике, «Сегодня» и карточке клиента: клик по задаче
 * открывает историю заметок клиента и поле для новой записи, не уводя
 * с текущего экрана. Один источник — GET /tasks/{id}/chat.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { Badge, Button, EmptyState, ErrorState, Field, Skeleton, textareaClass } from "@/components/ui";
import { api, TaskChat } from "@/lib/api";
import { PRIORITY_LABELS, TASK_TYPE_LABELS, dateRu, dateTimeRu } from "@/lib/format";

export function useTaskChat() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [chat, setChat] = useState<TaskChat | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const open = useCallback(async (id: string) => {
    setTaskId(id);
    setLoading(true);
    setError(null);
    setChat(null);
    setDraft("");
    try {
      const data = await api<TaskChat>(`/tasks/${id}/chat?limit=40`);
      setChat(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось открыть задачу");
    } finally {
      setLoading(false);
    }
  }, []);

  const close = useCallback(() => {
    setTaskId(null);
    setChat(null);
    setError(null);
  }, []);

  const reload = useCallback(async () => {
    if (!taskId) return;
    try {
      const data = await api<TaskChat>(`/tasks/${taskId}/chat?limit=40`);
      setChat(data);
    } catch {
      /* следующий клик перезагрузит */
    }
  }, [taskId]);

  return { taskId, chat, loading, error, draft, sending, open, close, reload, setDraft, setSending, setError };
}

export function TaskChatBody({
  chat,
  loading,
  error,
  draft,
  sending,
  onDraft,
  onSend,
  onRetry,
  onHistory,
}: {
  chat: TaskChat | null;
  loading: boolean;
  error: string | null;
  draft: string;
  sending: boolean;
  onDraft: (value: string) => void;
  onSend: () => void;
  onRetry?: () => void;
  /** true — показать историю изменений задачи (audit_log) */
  onHistory?: boolean;
}) {
  const [history, setHistory] = useState<
    { id: string; action: string; actor: string | null; created_at: string }[]
  >([]);
  const [tab, setTab] = useState<"notes" | "history">("notes");

  useEffect(() => {
    if (!onHistory || !chat || tab !== "history") return;
    let cancelled = false;
    api<{ items: typeof history }>(`/tasks/${chat.task.id}/history?limit=30`)
      .then((data) => {
        if (!cancelled) setHistory(data.items);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [chat, tab, onHistory]);

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 rounded-control" />
        <Skeleton className="h-16 rounded-control" />
        <Skeleton className="h-16 rounded-control" />
      </div>
    );
  }

  if (error && !chat) {
    return <ErrorState title="Не удалось открыть задачу" description={error} onRetry={onRetry} />;
  }

  if (!chat) return null;

  const ACTION_RU: Record<string, string> = {
    created: "Создана",
    updated: "Изменена",
    completed: "Закрыта",
    reopened: "Возвращена в работу",
    rescheduled: "Перенесён срок",
    deleted: "Удалена",
    rejected_by_user: "Отклонена менеджером",
    accepted_by_user: "Принята менеджером",
  };

  return (
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
        <span>{chat.task.due_date ? `срок ${dateRu(chat.task.due_date)}` : "без срока"}</span>
        {chat.task.source_quote && (
          <span className="w-full border-l-2 border-[var(--border-strong)] pl-2 italic">
            «{chat.task.source_quote}»
          </span>
        )}
      </div>

      {onHistory && (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setTab("notes")}
            aria-pressed={tab === "notes"}
            className={`focus-ring h-9 rounded-lg px-3 text-[13px] font-medium ${
              tab === "notes" ? "bg-primary text-white" : "bg-[#f1f4f9] text-[var(--muted)]"
            }`}
          >
            Заметки
          </button>
          <button
            type="button"
            onClick={() => setTab("history")}
            aria-pressed={tab === "history"}
            className={`focus-ring h-9 rounded-lg px-3 text-[13px] font-medium ${
              tab === "history" ? "bg-primary text-white" : "bg-[#f1f4f9] text-[var(--muted)]"
            }`}
          >
            История
          </button>
        </div>
      )}

      {tab === "history" && onHistory ? (
        <div className="max-h-[46vh] space-y-1.5 overflow-y-auto pr-1">
          {history.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-[var(--muted)]">
              Событий пока нет — история появится после первого действия.
            </p>
          ) : (
            history.map((item) => (
              <div
                key={item.id}
                className="rounded-control border border-[var(--border)] bg-[#f8fafd] px-2.5 py-2"
              >
                <p className="text-[13.5px] text-ink">{ACTION_RU[item.action] ?? item.action}</p>
                <p className="mt-0.5 text-[11.5px] text-[var(--muted)]">
                  {dateTimeRu(item.created_at)}
                  {item.actor ? ` · ${item.actor}` : ""}
                </p>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <p className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
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
                    {note.source_type === "voice" && <Badge tone="neutral">голос</Badge>}
                    {note.spawned_task && (
                      <Badge tone="primary">отсюда задача</Badge>
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
            <p className="text-[12px] text-[var(--muted)]">
              Показаны последние {chat.notes.length}. Более ранние — в разделе «Заметки».
            </p>
          )}
        </>
      )}

      <Field label="Новая заметка по этой задаче">
        <textarea
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          rows={3}
          placeholder="Например: созвонился, ждём счёт до пятницы"
          className={textareaClass}
        />
      </Field>
      {error && <p className="text-[12.5px] text-[var(--danger)]">{error}</p>}
      <Button onClick={onSend} loading={sending} disabled={!draft.trim()}>
        Добавить заметку
      </Button>
    </div>
  );
}
