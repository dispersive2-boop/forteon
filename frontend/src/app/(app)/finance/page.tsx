"use client";

/**
 * Раздел «Финансы» — общая сводка по доступным клиентам.
 *
 * DESIGN TASKS v2.1, §7:
 *  79  общая сводка по доступным клиентам
 *  80  вверху: выставлено, оплачено, долг, просрочено
 *  81  ниже таблица счетов и платежей с фильтрами
 *  82  долг считается из финансовых записей, не из заметок ИИ
 *  84  суммы с разделителями тысяч и валютой
 *  85  не смешивать сумму договора, доход, оплату и прибыль
 *  121 раздельные состояния: нет данных / ошибка / нет доступа
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  SectionTitle,
  Skeleton,
  Stat,
  Tabs,
} from "@/components/ui";
import { api } from "@/lib/api";
import { dateRu, money, statusLabel } from "@/lib/format";

type InvoiceRow = {
  id: string;
  client_id: string;
  client_name: string | null;
  number: string | null;
  issue_date: string | null;
  due_date: string | null;
  amount: number;
  allocated: number;
  remaining: number;
  status: string;
  overdue: boolean;
};

type PaymentRow = {
  id: string;
  client_id: string;
  client_name: string | null;
  amount: number;
  paid_at: string | null;
  method: string | null;
};

type Overview = {
  billed: number;
  paid: number;
  allocated: number;
  debt: number;
  overdue_amount: number;
  invoices: number;
  unpaid_invoices: number;
  clients: number;
  rows: InvoiceRow[];
  payments?: PaymentRow[];
};

type Tab = "invoices" | "payments";

export default function FinancePage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("invoices");
  const [query, setQuery] = useState("");
  const [onlyOverdue, setOnlyOverdue] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api<Overview>("/finance/overview");
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить финансы");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = data?.rows ?? [];
  const payments = data?.payments ?? [];

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (onlyOverdue && !row.overdue) return false;
      if (!needle) return true;
      return (
        (row.client_name ?? "").toLowerCase().includes(needle) ||
        (row.number ?? "").toLowerCase().includes(needle)
      );
    });
  }, [rows, query, onlyOverdue]);

  const filteredPayments = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return payments;
    return payments.filter((p) => (p.client_name ?? "").toLowerCase().includes(needle));
  }, [payments, query]);

  if (error && !data) {
    return (
      <div className="mx-auto max-w-[1500px]">
        <ErrorState description={error} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.028em] text-ink">
            Финансы
          </h1>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Сводка по {data?.clients ?? 0} доступным клиентам. Суммы считаются по счетам и
            распределённым оплатам, не по заметкам ИИ.
          </p>
        </div>
        <Link
          href="/reports"
          className="focus-ring inline-flex h-11 items-center rounded-control bg-primary px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[var(--primary-hover)]"
        >
          Выгрузить отчёт
        </Link>
      </header>

      {/* Пункт 80: четыре ключевых показателя сверху */}
      <div className="flex flex-wrap gap-2">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[62px] flex-1 rounded-control sm:w-[150px] sm:flex-none" />
          ))
        ) : (
          <>
            <Stat label="Выставлено" value={money(data?.billed ?? 0)} />
            <Stat label="Оплачено" value={money(data?.paid ?? 0)} tone="success" />
            <Stat
              label="Долг"
              value={money(data?.debt ?? 0)}
              tone={(data?.debt ?? 0) > 0 ? "danger" : "neutral"}
            />
            <Stat
              label="Просрочено"
              value={money(data?.overdue_amount ?? 0)}
              tone={(data?.overdue_amount ?? 0) > 0 ? "danger" : "neutral"}
            />
          </>
        )}
      </div>

      {error && data && (
        <div className="flex flex-wrap items-center gap-3 rounded-control border border-[#f3c7cb] bg-[var(--danger-soft)] px-3.5 py-2.5 text-[13px] text-[var(--danger)]">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            Повторить
          </Button>
        </div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
          <Tabs
            items={[
              { key: "invoices" as Tab, label: "Счета", count: data?.invoices ?? 0 },
              { key: "payments" as Tab, label: "Платежи", count: payments.length },
            ]}
            value={tab}
            onChange={setTab}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Клиент или номер счёта"
              className="focus-ring h-9 w-[220px] rounded-lg border border-[var(--border-strong)] px-3 text-[13px] text-ink placeholder:text-[#94A3B8]"
            />
            {tab === "invoices" && (
              <button
                type="button"
                onClick={() => setOnlyOverdue((v) => !v)}
                aria-pressed={onlyOverdue}
                className={`focus-ring h-9 rounded-lg border px-3 text-[13px] font-medium transition-colors ${
                  onlyOverdue
                    ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]"
                    : "border-[var(--border-strong)] text-[var(--muted)] hover:text-ink"
                }`}
              >
                Только просроченные
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-11 rounded-control" />
            ))}
          </div>
        ) : tab === "invoices" ? (
          filteredRows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-[13px]">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[11.5px] uppercase tracking-[0.05em] text-[var(--muted)]">
                    <th className="px-4 py-2.5 font-semibold">Клиент</th>
                    <th className="px-3 py-2.5 font-semibold">Счёт</th>
                    <th className="px-3 py-2.5 font-semibold">Срок</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Сумма</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Оплачено</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Остаток</th>
                    <th className="px-4 py-2.5 font-semibold">Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[#f8fafd]">
                      <td className="max-w-[240px] px-4 py-2.5">
                        <Link
                          href={`/clients/${row.client_id}?tab=finance`}
                          className="focus-ring block truncate font-medium text-primary hover:underline"
                        >
                          {row.client_name ?? "—"}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5 text-[var(--muted)]">{row.number ?? "без номера"}</td>
                      <td className={`px-3 py-2.5 ${row.overdue ? "font-semibold text-[var(--danger)]" : "text-[var(--muted)]"}`}>
                        {row.due_date ? dateRu(row.due_date) : "—"}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">{money(row.amount)}</td>
                      <td className="tabular px-3 py-2.5 text-right text-[var(--success)]">{money(row.allocated)}</td>
                      <td className="tabular px-3 py-2.5 text-right font-medium">{money(row.remaining)}</td>
                      <td className="px-4 py-2.5">
                        {row.overdue ? (
                          <Badge tone="danger">просрочен</Badge>
                        ) : (
                          <Badge tone={row.status === "paid" ? "success" : "neutral"}>
                            {row.status === "paid" ? "оплачен" : statusLabel(row.status)}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            /* Пункт 90: при отсутствии данных — предупреждение, а не пустой PDF/таблица */
            <EmptyState
              title={onlyOverdue ? "Просроченных счетов нет" : "Счетов пока нет"}
              description={
                onlyOverdue
                  ? "Снимите фильтр, чтобы увидеть все счета."
                  : "Счета создаются в карточке клиента на вкладке «Финансы»."
              }
              action={
                onlyOverdue ? (
                  <Button size="sm" variant="outline" onClick={() => setOnlyOverdue(false)}>
                    Снять фильтр
                  </Button>
                ) : (
                  <Link href="/clients" className="text-[13.5px] font-medium text-primary hover:underline">
                    Перейти к клиентам
                  </Link>
                )
              }
            />
          )
        ) : filteredPayments.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[11.5px] uppercase tracking-[0.05em] text-[var(--muted)]">
                  <th className="px-4 py-2.5 font-semibold">Клиент</th>
                  <th className="px-3 py-2.5 font-semibold">Дата</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Сумма</th>
                  <th className="px-4 py-2.5 font-semibold">Способ</th>
                </tr>
              </thead>
              <tbody>
                {filteredPayments.map((p) => (
                  <tr key={p.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[#f8fafd]">
                    <td className="max-w-[260px] px-4 py-2.5">
                      <Link
                        href={`/clients/${p.client_id}?tab=finance`}
                        className="focus-ring block truncate font-medium text-primary hover:underline"
                      >
                        {p.client_name ?? "—"}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-[var(--muted)]">{p.paid_at ? dateRu(p.paid_at) : "—"}</td>
                    <td className="tabular px-3 py-2.5 text-right font-medium text-[var(--success)]">
                      {money(p.amount)}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--muted)]">{p.method ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Платежей пока нет" description="Платежи вносятся в карточке клиента." />
        )}
      </Card>

      {/* Пункт 85: явно разделяем смысл величин */}
      <Card>
        <SectionTitle
          title="Как считаются суммы"
          subtitle="Чтобы не путать разные величины"
        />
        <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
          <div className="rounded-control bg-[#f8fafd] px-3 py-2">
            <dt className="font-medium text-ink">Выставлено</dt>
            <dd className="text-[var(--muted)]">Сумма всех действующих счетов, кроме отменённых.</dd>
          </div>
          <div className="rounded-control bg-[#f8fafd] px-3 py-2">
            <dt className="font-medium text-ink">Оплачено</dt>
            <dd className="text-[var(--muted)]">Сумма поступивших платежей.</dd>
          </div>
          <div className="rounded-control bg-[#f8fafd] px-3 py-2">
            <dt className="font-medium text-ink">Долг</dt>
            <dd className="text-[var(--muted)]">Выставлено минус распределённые по счетам оплаты.</dd>
          </div>
          <div className="rounded-control bg-[#f8fafd] px-3 py-2">
            <dt className="font-medium text-ink">Плановая выручка проекта</dt>
            <dd className="text-[var(--muted)]">Это не прибыль и не оплата — отдельная величина.</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
