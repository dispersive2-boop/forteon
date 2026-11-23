"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button, Field, Modal, inputClass } from "@/components/ui";
import { api } from "@/lib/api";
import { money, readAmount } from "@/lib/format";

type Invoice = { id: string; number: string | null; status: string; currency: string; amount: number; remaining?: number | null };

export function ClientFinanceEntry({ clientId, kind, onClose, onSaved }: {
  clientId: string;
  kind: "invoice" | "payment";
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const pending = useRef(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [number, setNumber] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const payment = kind === "payment";

  useEffect(() => {
    if (!payment) return;
    const controller = new AbortController();
    void api<Invoice[]>(`/clients/${clientId}/invoices`, { signal: controller.signal })
      .then((items) => setInvoices(items.filter((item) => item.status === "issued" && item.currency === "RUB")))
      .catch(() => { if (!controller.signal.aborted) setError("Список счетов не загрузился. Откройте форму заново, чтобы зачесть оплату."); });
    return () => controller.abort();
  }, [clientId, payment]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      const value = readAmount(amount);
      if (value === null || value <= 0) throw new Error("Сумма должна быть больше нуля.");
      const body = payment
        ? { amount: value, paid_at: date || null, invoice_id: invoiceId || null }
        : { amount: value, number: number.trim() || null, due_date: date || null };
      await api(`/clients/${clientId}/${payment ? "payments" : "invoices"}`, { method: "POST", body });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить запись");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  function close() {
    if (!pending.current) onClose();
  }

  return (
    <Modal open title={payment ? "Поступившая оплата" : "Новый счёт"} onClose={close} footer={
      <>
        <Button type="button" variant="ghost" disabled={saving} onClick={close}>Отмена</Button>
        <Button type="submit" form={id} disabled={!amount.trim()} loading={saving}>Сохранить</Button>
      </>
    }>
      <form id={id} onSubmit={save}>
        <fieldset disabled={saving} className="min-w-0 space-y-3">
          {!payment && <Field label="Номер счёта">
            <input className={inputClass} value={number} maxLength={64} onChange={(e) => setNumber(e.target.value)} />
          </Field>}
          <Field label="Сумма, ₽">
            <input required inputMode="decimal" className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={payment ? "Дата оплаты" : "Оплатить до"}>
            <input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          {payment && <Field label="Зачесть по счёту" hint="Без счёта поступление сохранится, но задолженность не уменьшится.">
            <select className={inputClass} value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
              <option value="">Без зачёта</option>
              {invoices.map((invoice) => <option key={invoice.id} value={invoice.id}>
                {invoice.number ? `№ ${invoice.number}` : "Без номера"} · {money(invoice.remaining ?? invoice.amount)}
              </option>)}
            </select>
          </Field>}
          {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        </fieldset>
      </form>
    </Modal>
  );
}
