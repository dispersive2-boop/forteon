"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, Field, SectionTitle, inputClass } from "@/components/ui";

type MailConnection = { url: string; username: string; connected: boolean };

export function MailSettings() {
  const [account, setAccount] = useState<MailConnection>({ url: "", username: "", connected: false });
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  useEffect(() => {
    let active = true;
    void api<MailConnection>("/mail/connection").then((data) => {
      if (active) setAccount(data);
    }).catch((error: Error) => {
      if (active) setMessage({ error: true, text: error.message });
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(undefined);
    try {
      const data = await api<MailConnection>("/mail/connection", {
        method: "PUT",
        body: { url: account.url, username: account.username, password: password || null },
      });
      setAccount(data);
      setPassword("");
      setMessage({ error: false, text: "Ящик подключён. Вход в Zimbra проверен." });
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : "Не удалось подключить почту." });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setMessage(undefined);
    try {
      await api("/mail/connection", { method: "DELETE" });
      setAccount({ url: account.url, username: "", connected: false });
      setPassword("");
    } catch (error) {
      setMessage({ error: true, text: error instanceof Error ? error.message : "Не удалось отключить ящик." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="mail-settings">
      <SectionTitle title="Почта Zimbra" subtitle={account.connected ? "Ящик подключён" : "Подключите свой рабочий ящик для отправки писем"} />
      <form onSubmit={(event) => void save(event)}>
        <fieldset className="grid min-w-0 gap-3 md:grid-cols-3" disabled={busy}>
          <Field label="HTTPS-адрес Zimbra">
            <input className={inputClass} type="url" required value={account.url} placeholder="https://mail.example.ru"
              onChange={(event) => setAccount({ ...account, url: event.target.value })} />
          </Field>
          <Field label="Логин почты">
            <input className={inputClass} required autoComplete="username" value={account.username}
              onChange={(event) => setAccount({ ...account, username: event.target.value })} />
          </Field>
          <Field label="Пароль почты" hint={account.connected ? "Заполните, чтобы заменить сохранённый пароль." : undefined}>
            <input className={inputClass} type="password" autoComplete="new-password" value={password}
              required={!account.connected} onChange={(event) => setPassword(event.target.value)} />
          </Field>
        </fieldset>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>Проверить и сохранить</Button>
          {account.connected && <Button type="button" variant="outline" disabled={busy} onClick={() => void disconnect()}>Отключить ящик</Button>}
        </div>
        {message && <p role={message.error ? "alert" : "status"} className="mt-2 text-sm">{message.text}</p>}
      </form>
    </Card>
  );
}
