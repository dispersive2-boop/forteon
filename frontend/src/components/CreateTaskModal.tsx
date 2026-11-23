"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button, Field, Modal, inputClass, textareaClass } from "@/components/ui";
import { api, type Paged, type Task } from "@/lib/api";
import { PRIORITY_LABELS, TASK_TYPE_LABELS } from "@/lib/format";

type ClientOption = { id: string; name: string };

export function CreateTaskModal({
  initialClient,
  initialDate,
  onClose,
  onCreated,
}: {
  initialClient?: ClientOption;
  initialDate: string;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const formId = useId();
  const submitting = useRef(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [client, setClient] = useState(initialClient);
  const [clientQuery, setClientQuery] = useState("");
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [loadingClients, setLoadingClients] = useState(true);
  const [searchError, setSearchError] = useState("");
  const [dueDate, setDueDate] = useState(initialDate);
  const [priority, setPriority] = useState("normal");
  const [type, setType] = useState("call");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: clientQuery.trim(), limit: "30" });
        const result = await api<Paged<ClientOption>>(`/clients?${params}`);
        if (active) setClients(result.items);
      } catch (err) {
        if (active) setSearchError(err instanceof Error ? err.message : "Не удалось загрузить клиентов");
      } finally {
        if (active) setLoadingClients(false);
      }
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [clientQuery]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !client || !title.trim()) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      const task = await api<Task>("/tasks", {
        method: "POST",
        body: {
          client_id: client.id,
          title: title.trim(),
          description: description.trim() || null,
          due_date: dueDate || null,
          priority,
          type,
        },
      });
      onCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать задачу");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  function close() {
    if (!submitting.current) onClose();
  }

  return (
    <Modal
      open
      title="Новая задача"
      onClose={close}
      footer={
        <>
          <Button type="button" variant="ghost" disabled={saving} onClick={close}>Отмена</Button>
          <Button type="submit" form={formId} disabled={!client || !title.trim()} loading={saving}>
            Создать задачу
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <fieldset disabled={saving} className="m-0 min-w-0 space-y-3 border-0 p-0">
          <Field label="Название задачи">
            <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)}
              required maxLength={512} autoFocus />
          </Field>
          <Field label="Поиск клиента">
            <input
              className={inputClass}
              value={clientQuery}
              placeholder="Название, ИНН или контакт"
              onChange={(event) => {
                setClientQuery(event.target.value);
                setLoadingClients(true);
                setSearchError("");
                setClients([]);
              }}
            />
          </Field>
          <Field label="Клиент">
            <select
              className={inputClass}
              value={client?.id ?? ""}
              required
              onChange={(event) => setClient(clients.find((item) => item.id === event.target.value))}
            >
              <option value="">Выбрать клиента</option>
              {client && !clients.some((item) => item.id === client.id) && <option value={client.id}>{client.name}</option>}
              {clients.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </Field>
          {searchError && <p role="alert" className="text-sm text-[var(--danger)]">{searchError}</p>}
          {loadingClients && <p role="status" className="text-sm text-[var(--muted)]">Ищем клиентов…</p>}
          {!loadingClients && !searchError && !clients.length && (
            <p role="status" className="text-sm text-[var(--muted)]">Клиенты не найдены</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Тип">
              <select className={inputClass} value={type} onChange={(event) => setType(event.target.value)}>
                {Object.entries(TASK_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Приоритет">
              <select className={inputClass} value={priority} onChange={(event) => setPriority(event.target.value)}>
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Срок" hint="Можно оставить без срока">
            <input className={inputClass} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
          </Field>
          <Field label="Описание">
            <textarea className={textareaClass} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
        </fieldset>
      </form>
    </Modal>
  );
}
