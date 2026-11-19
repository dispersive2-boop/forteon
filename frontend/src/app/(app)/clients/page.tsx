"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  Skeleton,
  StatusBadge,
  inputClass,
  textareaClass,
} from "@/components/ui";
import { api, Client, Paged } from "@/lib/api";
import { dateRu } from "@/lib/format";

const STATUS_OPTIONS = [
  { value: "", label: "Все статусы" },
  { value: "active", label: "Активные" },
  { value: "new", label: "Новые" },
];

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", legal_name: "", address: "", status: "active", notes_public: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);
      const data = await api<Paged<Client>>(`/clients?${params.toString()}`);
      setClients(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить клиентов");
    } finally {
      setLoading(false);
    }
  }, [query, status]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 320 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  async function createClient(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api<Client>("/clients", {
        method: "POST",
        body: {
          name: form.name.trim(),
          legal_name: form.legal_name.trim() || null,
          address: form.address.trim() || null,
          status: form.status,
          notes_public: form.notes_public.trim() || null,
          type: "legal",
          contacts: [],
        },
      });
      setCreateOpen(false);
      setForm({ name: "", legal_name: "", address: "", status: "active", notes_public: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать клиента");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[23px] font-semibold tracking-[-0.025em] text-ink">Клиенты</h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            {total} клиентов в вашей зоне ответственности
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Добавить клиента</Button>
      </header>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
          <div className="relative min-w-[220px] flex-1">
            <svg
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#6B7280]"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.6-3.6" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по названию или юрлицу"
              className="focus-ring h-9 w-full rounded-control border border-[var(--border-strong)] bg-surface pl-8.5 pr-3 text-[13px] text-ink placeholder:text-[#6B7280]"
            />
          </div>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="focus-ring h-9 rounded-control border border-[var(--border-strong)] bg-surface px-2.5 text-[12.5px] text-ink"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="border-b border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
            {error}
          </div>
        )}

        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : clients.length ? (
          <div className="divide-y divide-[var(--border)]">
            {clients.map((client) => (
              <Link
                key={client.id}
                href={`/clients/${client.id}`}
                className="focus-ring flex items-center gap-3 px-3.5 py-3 transition-colors hover:bg-[#f9fbfd]"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-control bg-[var(--primary-soft)] text-[12px] font-semibold text-primary">
                  {client.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-ink">{client.name}</span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-[var(--muted)]">
                    {client.legal_name || "Юридическое лицо не указано"}
                    {client.address ? ` · ${client.address}` : ""}
                  </span>
                </span>
                <span className="hidden shrink-0 items-center gap-2 sm:flex">
                  <StatusBadge status={client.status} />
                  <Badge tone="neutral">обновлён {dateRu(client.updated_at)}</Badge>
                </span>
                <svg className="shrink-0 text-[#c2cbdb]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </Link>
            ))}
          </div>
        ) : (
          <div className="p-4">
            <EmptyState
              title="Клиенты не найдены"
              description="Измените условия поиска или добавьте нового клиента."
              action={<Button variant="subtle" size="sm" onClick={() => setCreateOpen(true)}>Добавить клиента</Button>}
            />
          </div>
        )}
      </Card>

      <Modal
        open={createOpen}
        title="Новый клиент"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Отмена</Button>
            <Button onClick={createClient} loading={saving} disabled={!form.name.trim()}>
              Создать
            </Button>
          </>
        }
      >
        <form onSubmit={createClient} className="space-y-3">
          <Field label="Название *">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={inputClass}
              placeholder="Например, ЭКСПОЦЕНТР сервис"
              required
            />
          </Field>
          <Field label="Юридическое название">
            <input
              value={form.legal_name}
              onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
              className={inputClass}
              placeholder="ООО «…»"
            />
          </Field>
          <Field label="Адрес / расположение">
            <input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className={inputClass}
              placeholder="Москва"
            />
          </Field>
          <Field label="Статус">
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
              className={inputClass}
            >
              <option value="active">Активен</option>
              <option value="new">Новый</option>
            </select>
          </Field>
          <Field label="Заметка о клиенте">
            <textarea
              value={form.notes_public}
              onChange={(e) => setForm({ ...form, notes_public: e.target.value })}
              className={textareaClass}
              rows={3}
              placeholder="Контекст, особенности работы"
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
