"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { AudioDraft } from "@/components/AudioDraft";
import { useAuth } from "@/components/AuthProvider";
import { Button, Card, Field, SectionTitle, Skeleton, inputClass, textareaClass } from "@/components/ui";
import { api } from "@/lib/api";

type Recipient = { name: string; email: string; source?: "project" | "contact" | "zimbra" };
type Attachment = { id: string; filename: string; size: number };
type Draft = { recipient_query: string; subject: string; body: string; used_ai: boolean };
type Recording = {
  lang: string;
  onresult: null | ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void);
  onend: null | (() => void);
  onerror: null | (() => void);
  start: () => void;
  stop: () => void;
};

const examples = [
  "Отправь документы Чернильцеву",
  "Письмо для отдела закупок. Тема: Сроки поставки",
  "Кому: partner@example.ru. Текст: Подтвердите получение сметы",
];

export default function MailPage() {
  return <Suspense fallback={<Skeleton className="h-24" />}><MailWorkspace /></Suspense>;
}

function MailWorkspace() {
  const initialTo = useSearchParams().get("to") ?? "";
  const { user } = useAuth();
  const [connected, setConnected] = useState<boolean>();
  const [instruction, setInstruction] = useState("");
  const [recording, setRecording] = useState(false);
  const [address, setAddress] = useState(initialTo);
  const [recipientName, setRecipientName] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>();
  const [attachmentQuery, setAttachmentQuery] = useState("");
  const [documents, setDocuments] = useState<Attachment[]>();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [localFiles, setLocalFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<"draft" | "recipients" | "documents" | "send">();
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const speech = useRef<Recording | null>(null);
  const request = useRef<{ body: string; id: string } | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ connected: boolean }>("/mail/connection").then((data) => {
      if (active) setConnected(data.connected);
    }).catch(() => {
      if (active) setNotice({ error: true, text: "Не удалось проверить подключение почты." });
    });
    return () => {
      active = false;
      if (speech.current) {
        speech.current.onend = speech.current.onerror = speech.current.onresult = null;
        speech.current.stop();
      }
    };
  }, []);

  useEffect(() => {
    if (initialTo) {
      setAddress(initialTo);
      setRecipientName("");
    }
  }, [initialTo]);

  useEffect(() => {
    if (!user) return;
    const key = `forteon.forti.instruction.${user.id}`;
    const handoff = sessionStorage.getItem(key);
    if (handoff) {
      setInstruction(handoff);
      sessionStorage.removeItem(key);
    }
  }, [user]);

  function dictate() {
    if (recording) {
      speech.current?.stop();
      return;
    }
    const voice = window as Window & {
      SpeechRecognition?: new () => Recording;
      webkitSpeechRecognition?: new () => Recording;
    };
    const Recognition = voice.SpeechRecognition ?? voice.webkitSpeechRecognition;
    if (!Recognition) {
      setNotice({ error: true, text: "Диктовка недоступна в этом браузере. Введите команду или запишите аудиочерновик." });
      return;
    }
    const recognition = new Recognition();
    speech.current = recognition;
    recognition.lang = "ru-RU";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results, (result) => result[0].transcript).join(" ");
      setInstruction((current) => [current.trim(), transcript].filter(Boolean).join(" "));
    };
    recognition.onend = () => { speech.current = null; setRecording(false); };
    recognition.onerror = () => setNotice({ error: true, text: "Не удалось распознать речь. Проверьте микрофон." });
    try {
      recognition.start();
      setRecording(true);
      setNotice(undefined);
    } catch {
      speech.current = null;
      setNotice({ error: true, text: "Не удалось открыть микрофон." });
    }
  }

  async function findRecipients(query: string, projectsOnly = false) {
    const params = new URLSearchParams({ q: query });
    if (projectsOnly) params.set("source", "project");
    const result = await api<{ items: Recipient[] }>(`/mail/recipients?${params}`);
    setRecipients(result.items);
  }

  async function prepare() {
    if (!instruction.trim()) return;
    setBusy("draft");
    setNotice(undefined);
    setRecipients(undefined);
    try {
      const draft = await api<Draft>("/mail/draft", { method: "POST", body: { text: instruction } });
      setSubject(draft.subject);
      setText(draft.body);
      setRecipientQuery(draft.recipient_query);
      if (draft.recipient_query.includes("@")) {
        setAddress(draft.recipient_query);
        setRecipientName("");
      } else if (draft.recipient_query.length >= 2) {
        setAddress("");
        setRecipientName("");
        await findRecipients(draft.recipient_query);
      }
      setNotice({ error: false, text: "Проверьте адрес, текст и вложения перед отправкой." });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "Не удалось подготовить письмо." });
    } finally {
      setBusy(undefined);
    }
  }

  async function search(kind: "recipients" | "documents", projectsOnly = false) {
    const query = (kind === "recipients" ? recipientQuery : attachmentQuery).trim();
    if (query.length < 2 && !projectsOnly) return;
    setBusy(kind);
    setNotice(undefined);
    try {
      if (kind === "recipients") {
        if (projectsOnly) setRecipientQuery("");
        await findRecipients(projectsOnly ? "" : query, projectsOnly);
      } else {
        const result = await api<{ items: Attachment[] }>(`/mail/documents?q=${encodeURIComponent(query)}`);
        setDocuments(result.items);
      }
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "Поиск недоступен." });
    } finally {
      setBusy(undefined);
    }
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!connected || busy) return;
    const message = {
      to: address.trim(), recipient_name: recipientName || null, subject: subject.trim(), body: text.trim(),
      document_ids: attachments.map(({ id }) => id),
    };
    const signature = JSON.stringify([message, localFiles.map((file) => [file.name, file.size, file.lastModified])]);
    if (request.current?.body !== signature) request.current = { body: signature, id: crypto.randomUUID() };
    setBusy("send");
    setNotice(undefined);
    try {
      const payload = { ...message, request_id: request.current.id };
      if (localFiles.length) {
        const form = new FormData();
        form.append("message", JSON.stringify(payload));
        for (const file of localFiles) form.append("attachments", file);
        await api("/mail/send-files", { method: "POST", body: form });
      } else await api("/mail/send", { method: "POST", body: payload });
      request.current = null;
      setText("");
      setSubject("");
      setAttachments([]);
      setLocalFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      setNotice({ error: false, text: "Письмо отправлено через Zimbra." });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "Не удалось отправить письмо." });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="mx-auto max-w-[1240px] space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Image src="/forti.png" width={64} height={64} priority alt="" className="h-16 w-16 shrink-0 object-contain" />
          <div>
            <h1 className="text-2xl font-semibold text-ink">Форти и почта</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Подготовка писем и отправка через Zimbra</p>
          </div>
        </div>
        <Link href="/settings#mail-settings" className="focus-ring rounded-control px-3 py-2 text-sm font-medium text-primary">
          {connected ? "Настройки почты" : connected === false ? "Подключить почту" : "Настройки почты"}
        </Link>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <Card>
          <SectionTitle title="Поручение Форти" />
          <Field label="Команда">
            <textarea className={textareaClass} rows={4} maxLength={4000} value={instruction}
              onChange={(event) => setInstruction(event.target.value)} placeholder="Кому и что нужно отправить?" />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={Boolean(busy)} aria-pressed={recording} onClick={dictate}>
              {recording ? "Остановить диктовку" : "Диктовать"}
            </Button>
            <Button type="button" loading={busy === "draft"} disabled={Boolean(busy) || recording || !instruction.trim()}
              onClick={() => void prepare()}>Подготовить письмо</Button>
          </div>
          {user && <AudioDraft userId={`${user.id}:mail`} disabled={recording || Boolean(busy)}
            onTranscript={(value) => setInstruction((current) => [current.trim(), value].filter(Boolean).join(" ").slice(0, 4000))} />}
          <div className="mt-4 border-t border-[var(--border)] pt-3">
            <h3 className="text-sm font-semibold text-ink">Что умеет Форти</h3>
            <p className="my-2 text-sm text-[var(--muted)]">Помогает найти адрес по имени или объекту, составить письмо и добавить ссылки из команды. Файлы CRM можно выбрать в черновике.</p>
            <ul className="space-y-1">
              {examples.map((example) => <li key={example}>
                <button type="button" disabled={Boolean(busy)} className="focus-ring min-h-9 rounded-control px-2 text-left text-sm text-primary hover:bg-[var(--primary-soft)]"
                  onClick={() => setInstruction(example)}>{example}</button>
              </li>)}
            </ul>
          </div>
        </Card>

        <Card>
          <SectionTitle title="Письмо" />
          <form onSubmit={(event) => void send(event)}>
            <fieldset className="min-w-0 space-y-3" disabled={Boolean(busy)}>
              <Field label="Кому" hint={recipientName || undefined}>
                <input type="email" autoComplete="off" className={inputClass} value={address} required
                  onChange={(event) => { setAddress(event.target.value); setRecipientName(""); }} />
              </Field>
              <details open={recipients !== undefined || undefined}>
                <summary className="cursor-pointer rounded-control text-sm font-medium text-primary">Найти контакт или объект</summary>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label="Имя, адрес или название объекта">
                      <input className={inputClass} value={recipientQuery} onChange={(event) => setRecipientQuery(event.target.value)} />
                    </Field>
                  </div>
                  <Button type="button" variant="outline" loading={busy === "recipients"}
                    onClick={() => void search("recipients")} disabled={recipientQuery.trim().length < 2}>Найти</Button>
                  <Button type="button" variant="ghost" onClick={() => void search("recipients", true)}>Объекты с почтой</Button>
                </div>
                {recipients && <div className="mt-2 max-h-44 space-y-1 overflow-auto rounded-control border border-[var(--border)] p-1">
                  {recipients.length === 0 && <p className="p-2 text-sm text-[var(--muted)]">Совпадений нет. Можно ввести email вручную.</p>}
                  {recipients.map((item) => <button key={`${item.source}:${item.name}:${item.email}`} type="button"
                    className="focus-ring block w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-[var(--primary-soft)]"
                    onClick={() => { setAddress(item.email); setRecipientName(item.name); }}>
                    <span className="block break-words text-ink">{item.name}{item.source === "project" ? " · объект" : ""}</span>
                    <span className="break-all text-[var(--muted)]">{item.email}</span>
                  </button>)}
                </div>}
              </details>
              <Field label="Тема"><input className={inputClass} required maxLength={255} value={subject} onChange={(event) => setSubject(event.target.value)} /></Field>
              <Field label="Текст письма"><textarea className={textareaClass} rows={7} required maxLength={20000} value={text}
                onChange={(event) => setText(event.target.value)} /></Field>

              <details>
                <summary className="cursor-pointer text-sm font-medium text-primary">Вложения из ForteOn</summary>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Field label="Название файла">
                      <input className={inputClass} value={attachmentQuery} onChange={(event) => setAttachmentQuery(event.target.value)} />
                    </Field>
                  </div>
                  <Button type="button" variant="outline" loading={busy === "documents"}
                    disabled={attachmentQuery.trim().length < 2} onClick={() => void search("documents")}>Найти файлы</Button>
                </div>
                {documents?.length === 0 && <p className="mt-2 text-sm text-[var(--muted)]">Файлы не найдены.</p>}
                {documents && <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
                  {documents.map((item) => <li key={item.id}>
                    <Button type="button" size="sm" variant="ghost" className="w-full justify-start"
                      disabled={attachments.length + localFiles.length >= 10 || attachments.some(({ id }) => id === item.id)}
                      onClick={() => setAttachments((current) => [...current, item])}>{item.filename}</Button>
                  </li>)}
                </ul>}
              </details>
              {attachments.length > 0 && <ul className="flex flex-wrap gap-2">
                {attachments.map((item) => <li key={item.id} className="max-w-full">
                  <Button type="button" size="sm" variant="outline" aria-label={`Убрать ${item.filename}`}
                    onClick={() => setAttachments((current) => current.filter(({ id }) => id !== item.id))}>{item.filename} ×</Button>
                </li>)}
              </ul>}
              <Field label="Прикрепить файлы с устройства">
                <input ref={fileInput} type="file" multiple className={inputClass}
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    if (files.length + attachments.length > 10) {
                      event.target.value = "";
                      setLocalFiles([]);
                      setNotice({ error: true, text: "Можно приложить до 10 файлов." });
                    } else setLocalFiles(files);
                  }} />
              </Field>
              <Button type="submit" loading={busy === "send"} disabled={!connected || !address.trim() || !subject.trim() || !text.trim()}>
                Отправить
              </Button>
            </fieldset>
            {notice && <p role={notice.error ? "alert" : "status"} className={`mt-3 text-sm ${notice.error ? "text-[var(--danger)]" : "text-[var(--muted)]"}`}>{notice.text}</p>}
          </form>
        </Card>
      </div>
    </div>
  );
}
