"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";

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

const PAGE_SIZE = 100;

/*
 * п.27 «30 идей»: браузер не может восстановить прокрутку сам, потому что
 * в момент перезагрузки списка ещё нет (он приходит с сервера). Сохраняем
 * позицию сами и возвращаемся на неё, когда строки отрисованы.
 */
const SCROLL_KEY = "forteon.clients.scroll";

/*
 * п.26 «30 идей»: своя схема списка — фильтры **и** набор колонок.
 *
 * Почему не просто «сохранить поиск»: менеджеры смотрят на список по-разному.
 * Одному нужны только имена и ближайшее дело, другому — юрлицо, адрес и дата
 * обновления. Схема хранит ровно то, что человек выбрал, и восстанавливается
 * одним нажатием. Ключи колонок — стабильные строки, чтобы сохранённые
 * схемы не ломались при переименовании подписей.
 */
const CLIENT_COLUMNS = [
  { key: "next_step", label: "Ближайшее дело" },
  { key: "legal", label: "Юрлицо и адрес" },
  { key: "status", label: "Статус" },
  { key: "updated", label: "Обновлён" },
  { key: "risk", label: "Риск с причиной" },
] as const;

type ClientColumnKey = (typeof CLIENT_COLUMNS)[number]["key"];

const DEFAULT_COLUMNS: ClientColumnKey[] = ["next_step", "status", "updated"];

type ClientView = {
  name: string;
  query: string;
  status: string;
  /** Колонки, выбранные в момент сохранения схемы. */
  columns?: ClientColumnKey[];
};

/** Оставляем только известные ключи: старая схема не должна ломать список. */
function normalizeColumns(value: unknown): ClientColumnKey[] {
  const known = new Set<string>(CLIENT_COLUMNS.map((column) => column.key));
  if (!Array.isArray(value)) return DEFAULT_COLUMNS;
  const picked = value.filter((item): item is ClientColumnKey =>
    typeof item === "string" && known.has(item),
  );
  return picked.length ? picked : DEFAULT_COLUMNS;
}

const STATUS_OPTIONS = [
  { value: "", label: "Все статусы" },
  { value: "active", label: "Активные" },
  { value: "new", label: "Новые" },
];

export default function ClientsPage() {
  const { user } = useAuth();
  const viewKey = user ? `forteon.client-views.${user.id}` : null;
  const columnsKey = user ? `forteon.client-columns.${user.id}` : null;
  const [views, setViews] = useState<ClientView[]>([]);
  const [columns, setColumns] = useState<ClientColumnKey[]>(DEFAULT_COLUMNS);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [viewOpen, setViewOpen] = useState(false);
  const [viewError, setViewError] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", legal_name: "", address: "", status: "active", notes_public: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (query.trim()) params.set("q", query.trim());
        if (status) params.set("status", status);
        const data = await api<Paged<Client>>(`/clients?${params}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setClients((current) => {
          if (!offset) return data.items;
          const seen = new Set(current.map((client) => client.id));
          return [...current, ...data.items.filter((client) => !seen.has(client.id))];
        });
        setTotal(data.total);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Не удалось загрузить клиентов");
      } finally {
        if (!controller.signal.aborted) {
          setLoaded(true);
          setLoading(false);
        }
      }
    }, query.trim() && offset === 0 ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, status, offset, revision]);

  useEffect(() => {
    setViews([]);
    if (!viewKey) return;
    try {
      const stored = JSON.parse(localStorage.getItem(viewKey) ?? "[]");
      if (Array.isArray(stored)) {
        // Схемы из прошлых версий могли не знать про колонки — не падаем.
        setViews(
          stored
            .filter((item): item is ClientView => Boolean(item) && typeof item.name === "string")
            .map((item) => ({ ...item, columns: normalizeColumns(item.columns) })),
        );
      }
    } catch {
      setViewError("Не удалось прочитать сохранённые схемы.");
    }
  }, [viewKey]);

  /*
   * п.27: возвращаемся туда, где менеджер читал список.
   *
   * Ждём `loaded`, а не таймер: до появления строк документ короткий, и
   * scrollTo просто некуда прокручивать. Флаг в ref — чтобы вернуть позицию
   * один раз за загрузку страницы, а не на каждое обновление списка.
   */
  const scrollRestored = useRef(false);
  useEffect(() => {
    if (!loaded || scrollRestored.current) return;
    scrollRestored.current = true;
    let top = 0;
    try {
      top = Number(window.sessionStorage.getItem(SCROLL_KEY) ?? "0");
    } catch {
      return;
    }
    if (!Number.isFinite(top) || top <= 0) return;
    // Два кадра: строки успевают получить высоту, иначе прокрутка срывается.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => window.scrollTo({ top }));
    });
  }, [loaded]);

  /* Позицию пишем не на каждый пиксель, а когда прокрутка остановилась. */
  useEffect(() => {
    let timer = 0;
    const save = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          window.sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY)));
        } catch {
          /* приватный режим — просто не запоминаем */
        }
      }, 150);
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", save);
    };
  }, []);

  /* Колонки живут отдельно от схем: набор «сейчас» не обязан быть схемой. */
  useEffect(() => {
    if (!columnsKey) return;
    try {
      const stored = JSON.parse(localStorage.getItem(columnsKey) ?? "null");
      if (stored) setColumns(normalizeColumns(stored));
    } catch {
      /* приватный режим — остаёмся на колонках по умолчанию */
    }
  }, [columnsKey]);

  function writeViews(next: ClientView[]) {
    if (!viewKey) return false;
    try {
      localStorage.setItem(viewKey, JSON.stringify(next));
      setViews(next);
      setViewError("");
      return true;
    } catch {
      setViewError("Не удалось сохранить схемы в этом браузере.");
      return false;
    }
  }

  function writeColumns(next: ClientColumnKey[]) {
    setColumns(next);
    if (!columnsKey) return;
    try {
      localStorage.setItem(columnsKey, JSON.stringify(next));
    } catch {
      /* не смогли запомнить — набор всё равно применён на экране */
    }
  }

  function toggleColumn(key: ClientColumnKey) {
    const active = columns.includes(key);
    const next = active ? columns.filter((item) => item !== key) : [...columns, key];
    writeColumns(next);
  }

  async function createClient(event: React.FormEvent) {
    event.preventDefault();
    if (saving || !form.name.trim()) return;
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
      setOffset(0);
      setRevision((value) => value + 1);
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
            {loaded ? `Показано ${clients.length} из ${total}` : "Загружаем список"}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Добавить клиента</Button>
      </header>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
          <div className="relative min-w-0 flex-[1_1_12rem]">
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
              id="client-search"
              aria-label="Поиск клиента"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setOffset(0); }}
              type="search"
              placeholder="Название, ИНН или контакт"
              className="focus-ring h-9 w-full scroll-mt-24 rounded-control border border-[var(--border-strong)] bg-surface pl-9 pr-3 text-[13px] text-ink placeholder:text-[var(--muted)] focus:placeholder:text-transparent"
            />
          </div>
          <select
            value={status}
            aria-label="Статус клиента"
            onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
            className="focus-ring h-9 rounded-control border border-[var(--border-strong)] bg-surface px-2.5 text-[12.5px] text-ink"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* п.26: колонки — отдельный слой поверх фильтров, можно менять на ходу. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <Button size="sm" variant="ghost" aria-expanded={columnsOpen} onClick={() => setColumnsOpen(!columnsOpen)}>
            Колонки: {columns.length} из {CLIENT_COLUMNS.length}
          </Button>
          <span className="text-[11.5px] text-[var(--muted)]">
            Видно: {CLIENT_COLUMNS.filter((column) => columns.includes(column.key)).map((column) => column.label).join(", ")}
          </span>
        </div>
        {columnsOpen && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[#fafbfd] px-3 py-2">
            {CLIENT_COLUMNS.map((column) => {
              const active = columns.includes(column.key);
              return (
                <label key={column.key} className="inline-flex items-center gap-1.5 text-[12.5px] text-ink">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggleColumn(column.key)}
                    className="accent-primary"
                  />
                  {column.label}
                </label>
              );
            })}
            <Button size="sm" variant="ghost" onClick={() => writeColumns(DEFAULT_COLUMNS)}>
              По умолчанию
            </Button>
            {columns.length === 0 && (
              <span role="alert" className="text-[11.5px] text-[var(--warning)]">
                Ни одна колонка не выбрана — в строке останется только имя.
              </span>
            )}
          </div>
        )}

        {viewKey && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            {views.map((view) => (
              <span key={view.name} className="inline-flex items-center rounded-control border border-[var(--border)]">
                <Button
                  size="sm"
                  variant="ghost"
                  title={`Запрос: «${view.query || "все"}», статус: ${view.status || "любой"}, колонок: ${(view.columns ?? DEFAULT_COLUMNS).length}`}
                  onClick={() => {
                    setQuery(view.query);
                    setStatus(view.status);
                    writeColumns(view.columns ?? DEFAULT_COLUMNS);
                    setOffset(0);
                  }}
                >
                  {view.name}
                </Button>
                <Button size="sm" variant="ghost" aria-label={`Удалить фильтр «${view.name}»`}
                  onClick={() => writeViews(views.filter((item) => item.name !== view.name))}>×</Button>
              </span>
            ))}
            {viewOpen ? (
              <form className="flex flex-wrap gap-2" onSubmit={(event) => {
                event.preventDefault();
                const name = viewName.trim();
                if (!name) return;
                if (writeViews([...views.filter((item) => item.name !== name), { name, query, status, columns }])) {
                  setViewName(""); setViewOpen(false);
                }
              }}>
                <input className="focus-ring rounded-control border border-[var(--border)] bg-surface px-2 text-sm"
                  aria-label="Название фильтра" placeholder="Название фильтра" maxLength={40} value={viewName}
                  onChange={(event) => setViewName(event.target.value)} />
                <Button type="submit" size="sm" disabled={!viewName.trim()}>Сохранить</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setViewOpen(false)}>Отмена</Button>
              </form>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setViewOpen(true)}>Сохранить фильтр</Button>
            )}
            {viewError && <span role="alert" className="text-xs text-[var(--danger)]">{viewError}</span>}
          </div>
        )}

        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
            <span>{error}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>Повторить загрузку</Button>
          </div>
        )}

        {!loaded ? (
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
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium text-ink">{client.name}</span>
                    {client.risk ? (
                      <span
                        title={client.risk.reason}
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
                          client.risk.level === "critical"
                            ? "bg-[var(--danger-soft)] text-[var(--danger)]"
                            : "bg-[var(--warning-soft)] text-[var(--warning)]"
                        }`}
                      >
                        {client.risk.level === "critical" ? "Риск" : "Внимание"}
                      </span>
                    ) : null}
                  </span>
                  {/*
                    п.26: подпись под именем собирается из выбранных колонок.
                    Имя и «перейти» остаются всегда — без них строкой нельзя
                    пользоваться; остальное менеджер включает сам.
                  */}
                  {columns.includes("next_step") && (
                    client.next_step ? (
                      <span className="mt-0.5 block truncate text-[11.5px] text-[var(--muted)]">
                        {client.next_step.kind === "overdue" ? "Просрочено: " : ""}
                        {client.next_step.kind === "waiting" ? "Ждём: " : ""}
                        {client.next_step.title}
                        {client.next_step.due_date ? ` · ${dateRu(client.next_step.due_date)}` : ""}
                      </span>
                    ) : (
                      <span className="mt-0.5 block truncate text-[11.5px] text-[var(--muted)]">
                        Дел в работе нет
                      </span>
                    )
                  )}
                  {columns.includes("legal") && (
                    <span className="mt-0.5 block truncate text-[11.5px] text-[var(--muted)]">
                      {client.legal_name || "Юридическое лицо не указано"}
                      {client.address ? ` · ${client.address}` : ""}
                    </span>
                  )}
                  {columns.includes("risk") && client.risk ? (
                    <span
                      className={`mt-0.5 block truncate text-[11px] ${
                        client.risk.level === "critical" ? "text-[var(--danger)]" : "text-[var(--warning)]"
                      }`}
                    >
                      {client.risk.reason}
                    </span>
                  ) : null}
                </span>
                <span className="hidden shrink-0 items-center gap-2 sm:flex">
                  {columns.includes("status") && <StatusBadge status={client.status} />}
                  {columns.includes("updated") && (
                    <Badge tone="neutral">обновлён {dateRu(client.updated_at)}</Badge>
                  )}
                </span>
                <svg className="shrink-0 text-[#c2cbdb]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </Link>
            ))}
          </div>
        ) : !loading && !error ? (
          <div className="p-4">
            <EmptyState
              title="Клиенты не найдены"
              description="Измените условия поиска или добавьте нового клиента."
              action={<Button variant="subtle" size="sm" onClick={() => setCreateOpen(true)}>Добавить клиента</Button>}
            />
          </div>
        ) : null}
        {loaded && !error && clients.length > 0 && offset + PAGE_SIZE < total && (
          <div className="flex justify-center border-t border-[var(--border)] p-3">
            <Button variant="outline" loading={loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
              Показать ещё
            </Button>
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
