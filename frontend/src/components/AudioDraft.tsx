"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui";
import { api } from "@/lib/api";

async function audioStorage(mode: "read" | "save" | "remove", key: string, blob?: Blob): Promise<Blob | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("forteon-audio-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<Blob | undefined>((resolve, reject) => {
      const transaction = db.transaction("drafts", mode === "read" ? "readonly" : "readwrite");
      const store = transaction.objectStore("drafts");
      const request = mode === "read" ? store.get(key) : mode === "save" ? store.put(blob, key) : store.delete(key);
      transaction.oncomplete = () => resolve(mode === "read" ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export function AudioDraft({ userId, disabled, onTranscript }: {
  userId: string;
  disabled?: boolean;
  onTranscript: (text: string) => void;
}) {
  const recorder = useRef<MediaRecorder | null>(null);
  const mounted = useRef(false);
  const [starting, setStarting] = useState(false);
  const [audio, setAudio] = useState<Blob>();
  const [url, setUrl] = useState<string>();
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void audioStorage("read", userId).then((blob) => {
      if (active) setAudio(blob);
    }).catch(() => {});
    return () => {
      active = false;
      mounted.current = false;
      if (recorder.current?.state === "recording") recorder.current.stop();
    };
  }, [userId]);

  useEffect(() => {
    if (!audio) {
      setUrl(undefined);
      return;
    }
    const objectUrl = URL.createObjectURL(audio);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [audio]);

  async function record() {
    if (recorder.current?.state === "recording") {
      recorder.current.stop();
      return;
    }
    if (starting) return;
    setStarting(true);
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      let instance: MediaRecorder;
      try {
        instance = new MediaRecorder(stream);
      } catch (err) {
        stream.getTracks().forEach((track) => track.stop());
        throw err;
      }
      recorder.current = instance;
      const chunks: Blob[] = [];
      let size = 0;
      instance.ondataavailable = (event) => {
        chunks.push(event.data);
        size += event.data.size;
        if (size >= 9 * 1024 * 1024 && instance.state === "recording") instance.stop();
      };
      instance.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: instance.mimeType.split(";")[0] });
        if (!blob.size) return;
        setAudio(blob);
        void audioStorage("save", userId, blob).catch(() => setError("Не удалось сохранить запись между сеансами. Пока она доступна на этой странице."));
      };
      instance.start(1000);
      setRecording(true);
    } catch {
      setError("Не удалось начать запись. Проверьте доступ браузера к микрофону.");
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function transcribe() {
    if (!audio) return;
    setBusy(true);
    setError("");
    try {
      const data = new FormData();
      data.append("file", audio, "note-audio");
      const { text } = await api<{ text: string }>("/voice/audio", { method: "POST", body: data });
      onTranscript(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось распознать запись.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="mt-2 rounded-control border border-[var(--border)] px-2 py-1 text-sm">
      <summary className="cursor-pointer font-medium text-primary">Запись аудиочерновика</summary>
      <div className="my-2 flex flex-wrap items-center gap-2">
        {url && <audio controls src={url} className="max-w-full" aria-label="Аудиочерновик" />}
        {(!audio || recording) && <Button type="button" size="sm" variant="outline" disabled={disabled || busy || starting}
          onClick={() => void record()}>{recording ? "Завершить запись" : "Начать запись"}</Button>}
        {audio && !recording && <>
          <Button type="button" size="sm" loading={busy} disabled={disabled} onClick={() => void transcribe()}>Расшифровать</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={async () => {
            try { await audioStorage("remove", userId); setAudio(undefined); setError(""); }
            catch { setError("Браузер не удалил черновик. Попробуйте ещё раз."); }
          }}>Удалить запись</Button>
        </>}
      </div>
      {error && <p role="alert" className="mb-2 text-[var(--danger)]">{error}</p>}
    </details>
  );
}
