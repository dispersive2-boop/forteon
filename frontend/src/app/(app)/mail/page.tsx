"use client";

import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AudioDraft } from "@/components/AudioDraft";
import { Button, Skeleton, textareaClass } from "@/components/ui";
import { api } from "@/lib/api";

type Contact = { email: string; name: string; source?: string };
type Turn = { question: string; contacts?: Contact[]; answer: string; draft?: string };

const examples = ["Найди почту Чернильцева", "Покажи объекты с почтой", "Напиши письмо: подтвердите получение сметы"];

export default function MailPage() {
  return <Suspense fallback={<Skeleton className="h-24" />}><Forti /></Suspense>;
}

function Forti() {
  const address = useSearchParams().get("to");
  const { user } = useAuth();
  const [connected, setConnected] = useState<boolean>();
  const [query, setQuery] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void api<{ connected: boolean }>("/mail/connection").then(({ connected }) => setConnected(connected)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    const key = `forteon.forti.instruction.${user.id}`;
    const handoff = sessionStorage.getItem(key);
    if (handoff) {
      setQuery(handoff);
      sessionStorage.removeItem(key);
    }
  }, [user]);

  useEffect(() => {
    if (address) setTurns([{ question: "Почта объекта", answer: address }]);
  }, [address]);

  async function ask(question: string) {
    const value = question.trim();
    if (!value || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const projects = /^покажи объекты с почтой$/i.test(value);
      const lookup = value.match(/^(?:найди|покажи|какая)\s+(?:(?:почту|почта|адрес|email)\s+)?(?:у\s+)?(.+)$/i)?.[1];
      const writing = /^(?:напиши|составь|подготовь|отправь)/i.test(value);
      const draft = writing && !lookup ? await api<{ recipient_query: string; subject: string; body: string }>("/mail/draft", {
        method: "POST", body: { text: value },
      }) : undefined;
      const term = (lookup ?? draft?.recipient_query ?? value).trim().replace(/[?!.,]+$/, "");
      // Search the directory with a surname stem for common Russian case endings.
      const directoryTerm = lookup || draft?.recipient_query ? term.replace(/(ов|ев|ин)а(?=\s|$)/gi, "$1") : term;
      let items: Contact[] = [];
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(term)) {
        items = [{ email: term, name: "Указанный адрес" }];
      } else if (projects || !draft || draft.recipient_query) {
        const path = projects ? "/mail/recipients?source=project" : `/mail/recipients?q=${encodeURIComponent(term)}`;
        items = (await api<{ items: Contact[] }>(path)).items;
        if (!projects && !items.length && term !== directoryTerm) {
          items = (await api<{ items: Contact[] }>(`/mail/recipients?q=${encodeURIComponent(directoryTerm)}`)).items;
        }
      }
      const answer = items.length ? (items.length === 1 ? "Нашёл адрес." : "Нашёл несколько вариантов.") :
        draft ? "Подготовил черновик." : connected === false ? "В CRM совпадений нет. Подключите ящик для поиска по Zimbra." : "Совпадений нет. Попробуйте фамилию или название объекта.";
      setTurns((current) => [...current, { question: value, contacts: items, answer,
        draft: draft ? [draft.subject, draft.body].filter(Boolean).join("\n\n") : undefined }]);
      setQuery("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось выполнить поиск.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[760px] space-y-5 pb-8">
      <header className="flex items-center gap-3">
        <Image src="/forti.png" width={56} height={56} alt="" />
        <h1 className="text-2xl font-semibold text-ink">Форти</h1>
        {connected === false && <Link href="/settings#mail-settings" className="ml-auto text-sm text-primary">Подключить Zimbra</Link>}
      </header>
      {turns.length === 0 && <div className="flex flex-wrap gap-2">
        {examples.map((example) => <Button key={example} size="sm" variant="outline" disabled={busy} onClick={() => void ask(example)}>{example}</Button>)}
      </div>}
      <div aria-live="polite" className="space-y-4">
        {turns.map((turn, index) => (
          <div key={index} className="space-y-2">
            <p className="ml-auto w-fit max-w-[90%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--primary-soft)] px-4 py-2.5 text-sm text-ink">{turn.question}</p>
            <div className="forteon-floating max-w-full space-y-2 p-4 text-sm">
              <p>{turn.answer}</p>
              {turn.contacts?.map((contact, contactIndex) => <div key={`${contact.email}-${contactIndex}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--canvas)] px-3 py-2">
                <div className="min-w-0"><p className="font-semibold">{contact.name}</p><a className="break-all text-primary" href={`mailto:${contact.email}`}>{contact.email}</a></div>
                <Button type="button" variant="ghost" size="sm" onClick={() => {
                  void navigator.clipboard.writeText(contact.email).then(() => setNotice("Адрес скопирован.")).catch(() => setNotice("Не удалось скопировать адрес."));
                }}>Копировать</Button>
              </div>)}
              {turn.draft && <p className="whitespace-pre-wrap break-words rounded-xl bg-[var(--canvas)] p-3">{turn.draft}</p>}
            </div>
          </div>
        ))}
      </div>
      <form className="forteon-floating space-y-2 p-3" onSubmit={(event) => { event.preventDefault(); void ask(query); }}>
        <textarea aria-label="Сообщение Форти" className={textareaClass} rows={2} value={query} maxLength={4000}
          placeholder="Имя, объект или поручение" onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(query); } }} />
        <div className="flex items-center justify-end"><Button type="submit" loading={busy} disabled={!query.trim()}>Спросить</Button></div>
        {user && <AudioDraft userId={`${user.id}:mail`} disabled={busy} onTranscript={setQuery} />}
      </form>
      {notice && <p role="status" className="text-sm text-[var(--muted)]">{notice}</p>}
    </div>
  );
}
