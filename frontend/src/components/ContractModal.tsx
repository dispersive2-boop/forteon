"use client";

/**
 * п.15 «30 идей»: договор в карточке проекта.
 *
 * Раньше у договора были только номер, дата и сумма — менеджер не мог
 * ответить ни «этот договор оплачен?», ни «где подписанный скан».
 * Теперь при создании можно сразу выбрать счёт, а после — прикрепить файл
 * из документов клиента.
 */
import { useId, useRef, useState, type FormEvent } from "react";

import { Button, Field, Modal, inputClass } from "@/components/ui";
import {
  api,
  type ClientContract,
  type ClientDocument,
  type ClientInvoice,
  type Project,
} from "@/lib/api";
import { money, readAmount } from "@/lib/format";

export function ContractModal({
  clientId,
  projects,
  invoices,
  documents,
  onClose,
  onSaved,
}: {
  clientId: string;
  projects: Project[];
  invoices: ClientInvoice[];
  documents: ClientDocument[];
  onClose: () => void;
  onSaved: (contract: ClientContract) => void;
}) {
  const formId = useId();
  const pending = useRef(false);
  const [number, setNumber] = useState("");
  const [signedAt, setSignedAt] = useState("");
  const [amount, setAmount] = useState("");
  const [projectId, setProjectId] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    let amountValue: number | null = null;
    try {
      amountValue = readAmount(amount);
    } catch (err) {
      pending.current = false;
      setSaving(false);
      setError(err instanceof Error ? err.message : "Сумма указана неверно");
      return;
    }
    try {
      const created = await api<ClientContract>(`/clients/${clientId}/contracts`, {
        method: "POST",
        body: {
          number: number.trim() || null,
          signed_at: signedAt || null,
          amount: amountValue,
          project_id: projectId || null,
          invoice_id: invoiceId || null,
        },
      });
      // Файл прикрепляем вторым шагом: договор уже создан, и сбой привязки
      // не должен «прятать» сам договор от менеджера.
      let saved = created;
      if (documentId) {
        try {
          saved = await api<ClientContract>(
            `/contracts/${created.id}/documents/${documentId}`,
            { method: "POST" },
          );
        } catch (attachError) {
          onSaved(created);
          setError(
            attachError instanceof Error
              ? `Договор создан, но файл не прикреплён: ${attachError.message}`
              : "Договор создан, но файл не прикреплён",
          );
          return;
        }
      }
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить договор");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  function close() {
    if (!pending.current) onClose();
  }

  const chosenInvoice = invoices.find((invoice) => invoice.id === invoiceId);

  return (
    <Modal
      open
      title="Новый договор"
      onClose={close}
      footer={
        <>
          <Button type="button" variant="ghost" disabled={saving} onClick={close}>
            Отмена
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            Сохранить
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <fieldset disabled={saving} className="min-w-0 space-y-3">
          <Field label="Номер договора">
            <input
              maxLength={128}
              className={inputClass}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Например, 17/2026"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Дата подписания">
              <input
                type="date"
                className={inputClass}
                value={signedAt}
                onChange={(e) => setSignedAt(e.target.value)}
              />
            </Field>
            <Field label="Сумма договора, ₽">
              <input
                inputMode="decimal"
                className={inputClass}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Необязательно"
              />
            </Field>
          </div>
          {projects.length > 0 && (
            <Field label="Проект" hint="Договор можно привязать к объекту клиента.">
              <select
                className={inputClass}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">Без проекта</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field
            label="Счёт"
            hint={
              invoices.length === 0
                ? "У клиента ещё нет счетов — договор сохранится без оплаты."
                : "По счёту сразу видно, сколько уже зачтено."
            }
          >
            <select
              className={inputClass}
              value={invoiceId}
              onChange={(e) => setInvoiceId(e.target.value)}
              disabled={invoices.length === 0}
            >
              <option value="">Без счёта</option>
              {invoices.map((invoice) => (
                <option key={invoice.id} value={invoice.id}>
                  {invoice.number ? `№${invoice.number}` : invoice.id.slice(0, 8)} —{" "}
                  {money(invoice.amount, invoice.currency)}
                </option>
              ))}
            </select>
          </Field>
          {chosenInvoice && (
            <p className="rounded-control bg-canvas px-3 py-2 text-[12.5px] text-[var(--muted)]">
              Остаток по счёту: {money(chosenInvoice.remaining ?? chosenInvoice.amount, chosenInvoice.currency)}
            </p>
          )}
          <Field
            label="Подписанный файл"
            hint={
              documents.length === 0
                ? "Файлов у клиента нет. Загрузите его во вкладке «Документы»."
                : "Выберите файл из документов клиента."
            }
          >
            <select
              className={inputClass}
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              disabled={documents.length === 0}
            >
              <option value="">Не прикреплять</option>
              {documents.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.filename}
                </option>
              ))}
            </select>
          </Field>
          {error && (
            <p className="rounded-control bg-[#FEF2F2] px-3 py-2 text-[12.5px] text-[#B91C1C]">
              {error}
            </p>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
