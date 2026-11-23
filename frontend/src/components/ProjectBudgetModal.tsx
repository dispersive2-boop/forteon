"use client";

import { useId, useRef, useState, type FormEvent } from "react";

import { Button, Field, Modal, inputClass } from "@/components/ui";
import { api, type Project } from "@/lib/api";
import { money, readAmount } from "@/lib/format";

export function ProjectBudgetModal({ clientId, project, onClose, onSaved }: {
  clientId: string;
  project: Project | null;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const formId = useId();
  const pending = useRef(false);
  const [name, setName] = useState(project?.name ?? "");
  const [revenue, setRevenue] = useState(String(project?.planned_revenue ?? ""));
  const [cost, setCost] = useState(String(project?.estimated_cost ?? ""));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !name.trim()) return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const amounts = { planned_revenue: readAmount(revenue), estimated_cost: readAmount(cost) };
      const saved = await api<Project>(project ? `/projects/${project.id}` : `/clients/${clientId}/projects`, {
        method: project ? "PATCH" : "POST",
        body: project ? { ...amounts, version: project.version } : { ...amounts, name: name.trim() },
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить проект");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  function close() {
    if (!pending.current) onClose();
  }

  let profit: number | null = null;
  try {
    const planned = readAmount(revenue);
    const estimated = readAmount(cost);
    if (planned !== null && estimated !== null) profit = planned - estimated;
  } catch {
    // Сообщение об ошибке показываем при сохранении.
  }

  return (
    <Modal open title={project ? "Суммы проекта" : "Новый проект"} onClose={close} footer={
      <>
        <Button type="button" variant="ghost" disabled={saving} onClick={close}>Отмена</Button>
        <Button type="submit" form={formId} disabled={!name.trim()} loading={saving}>Сохранить</Button>
      </>
    }>
      <form id={formId} onSubmit={submit}>
        <fieldset disabled={saving} className="min-w-0 space-y-3">
          {project ? <p className="break-words text-sm font-medium text-ink">{project.name}</p> : (
            <Field label="Название проекта">
              <input required maxLength={255} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          )}
          <Field label="Плановый доход, ₽">
            <input inputMode="decimal" className={inputClass} value={revenue} onChange={(e) => setRevenue(e.target.value)} />
          </Field>
          <Field label="Оценка затрат, ₽">
            <input inputMode="decimal" className={inputClass} value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
          <div className="rounded-control bg-canvas px-3 py-2 text-sm">
            <p className="font-medium text-ink">Ожидаемая прибыль</p>
            <p className="mt-1 text-[var(--muted)]" aria-live="polite">
              {profit === null ? "Укажите доход и затраты." : money(profit)}
            </p>
          </div>
          {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        </fieldset>
      </form>
    </Modal>
  );
}
