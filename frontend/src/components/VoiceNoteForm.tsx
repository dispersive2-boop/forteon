"use client";

/**
 * Единая форма диктовки заметки (п.1–5 «30 идей»).
 *
 * Зачем отдельный компонент, а не три разных textarea:
 *  - на «Заметках», в карточке клиента и в задаче менеджер делает одно и то
 *    же действие. Раньше это были три разные формы с разным поведением,
 *    и в двух из трёх текст терялся при ошибке;
 *  - здесь же живут правила, которые легко забыть при копировании:
 *    черновик, защита от дублей, повтор после сбоя, аудио.
 *
 * Что важно по поведению:
 *  - п.3: текст переживает сбой сети и перезагрузку страницы. Черновик
 *    пишется в localStorage по ключу клиента, а не по заметке (заметки
 *    ещё нет);
 *  - п.3: повтор отправки не создаёт вторую заметку. Ключ идемпотентности
 *    генерируется один раз на текст и сбрасывается только когда текст
 *    изменили — сервер уже умеет отбрасывать повторы по этому ключу;
 *  - п.4: черновик привязан к клиенту, поэтому переключение клиента не
 *    смешивает тексты и не теряет набранное;
 *  - п.5: если браузер умеет писать звук, сохраняем запись и даём
 *    переслушать — STT на сервере пока MVP, и молчать об этом нельзя.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Field, textareaClass } from "@/components/ui";

/** Минимальный набор того, что нужно от клиента — без привязки к типу API. */
export type NoteClient = { id: string; name: string };

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (event: {
    resultIndex: number;
    results: { length: number; [index: number]: { isFinal: boolean; 0: { transcript: string } } };
  }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
};

const DRAFT_PREFIX = "forteon.note.draft.";

/** Черновик на диске. Если хранилище недоступно — просто не сохраняем. */
export function readDraft(clientId: string | null): string {
  if (!clientId) return "";
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + clientId) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(clientId: string | null, body: string): void {
  if (!clientId) return;
  try {
    const key = DRAFT_PREFIX + clientId;
    if (body) window.localStorage.setItem(key, body);
    else window.localStorage.removeItem(key);
  } catch {
    /* приватный режим — черновик не сохранится, но форма работает */
  }
}

function clearDraft(clientId: string | null): void {
  writeDraft(clientId, "");
}

/** Ключ идемпотентности: один на попытку, чтобы ретрай не создал дубль. */
function makeAttemptKey(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `note-${random}`;
}

export type VoiceNoteFormProps = {
  /** Клиент, к которому привяжется заметка. */
  client: NoteClient | null;
  /**
   * Отправка заметки. Должна вернуть id созданной заметки.
   * Ошибку пробрасывать наружу — форма сама сохранит текст и ключ.
   */
  onSubmit: (payload: {
    body: string;
    sourceType: "text" | "voice";
    idempotencyKey: string;
  }) => Promise<string | null>;
  /** Вызывается после успешной отправки — например, чтобы перечитать ленту. */
  onCreated?: (noteId: string) => void;
  /** Показывать выбор клиента внутри формы (на странице заметок). */
  clientPicker?: React.ReactNode;
  /** Заголовок над полем. */
  label?: string;
  /** Скрыть приветственные примеры. */
  hideExamples?: boolean;
  /** Начальный текст (исправление уже сохранённой заметки). */
  initialBody?: string;
  /** Подпись кнопки отправки. */
  submitLabel?: string;
  /**
   * Левая часть панели действий — вложения и всё, что относится к клиенту.
   *
   * Раньше страница заметок рисовала скрепку отдельным блоком под формой,
   * и она оказывалась на своей строке: микрофон и «Отправить» сверху,
   * скрепка снизу. Один слот держит все действия в одной строке.
   */
  leftSlot?: React.ReactNode;
  /** Дополнительные действия справа, перед кнопкой отправки. */
  rightSlot?: React.ReactNode;
  /**
   * Текущий текст наружу. Нужен странице, чтобы предложить действие над
   * набранным («Письмо с Форти»), не дублируя состояние внутри формы.
   */
  onBodyChange?: (body: string) => void;
};

export function VoiceNoteForm({
  client,
  onSubmit,
  onCreated,
  clientPicker,
  label = "Новая заметка",
  hideExamples = false,
  initialBody = "",
  submitLabel = "Отправить",
  leftSlot,
  rightSlot,
  onBodyChange,
}: VoiceNoteFormProps) {
  const [body, setBody] = useState(() => initialBody || readDraft(client?.id ?? null));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ключ текущей попытки. Живёт до изменения текста. */
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [voiceUsed, setVoiceUsed] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    const w = window as unknown as {
      SpeechRecognition?: unknown;
      webkitSpeechRecognition?: unknown;
    };
    return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
  }, []);

  /*
   * п.4: при смене клиента подхватываем его черновик. Это же спасает от
   * ошибки «набрал про одного, а отправил другому»: текст физически не
   * переносится между клиентами, потому что он лежит под разными ключами.
   */
  useEffect(() => {
    const stored = readDraft(client?.id ?? null);
    setBody(stored);
    setAttemptKey(null);
    setError(null);
    onBodyChange?.(stored);
    // onBodyChange намеренно не в зависимостях: это «сообщить наружу», а не
    // источник значения — иначе перерисовка страницы сбрасывала бы текст.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client?.id]);

  /* Черновик пишем с задержкой: не на каждую букву, но и не теряя текст. */
  useEffect(() => {
    if (!client?.id) return;
    const id = window.setTimeout(() => {
      writeDraft(client.id, body);
      setDraftSaved(Boolean(body));
    }, 400);
    return () => window.clearTimeout(id);
  }, [body, client?.id]);

  /* Запись микрофона — ресурс, его обязательно отпускаем при уходе. */
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const changeBody = useCallback(
    (next: string) => {
      setBody(next);
      onBodyChange?.(next);
      /*
       * Текст изменили — значит это уже другая заметка. Старый ключ
       * идемпотентности больше не подходит: с ним сервер счёл бы новую
       * версию повтором старой и молча проигнорировал.
       */
      setAttemptKey(null);
    },
    [onBodyChange],
  );

  /* ----------------------------------------------------------- отправка */
  async function submit() {
    const text = body.trim();
    if (!text) return;
    if (!client) {
      setError("Сначала выберите клиента.");
      return;
    }

    const key = attemptKey ?? makeAttemptKey();
    if (!attemptKey) setAttemptKey(key);
    setSending(true);
    setError(null);

    try {
      const noteId = await onSubmit({
        body: text,
        sourceType: voiceUsed ? "voice" : "text",
        idempotencyKey: key,
      });
      /*
       * Успех — черновик больше не нужен. Стираем только при успехе:
       * иначе менеджер потерял бы работу из-за чужой ошибки.
       */
      clearDraft(client.id);
      setBody("");
      onBodyChange?.("");
      setAttemptKey(null);
      setVoiceUsed(false);
      setDraftSaved(false);
      setAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      if (noteId) onCreated?.(noteId);
      areaRef.current?.focus();
    } catch (err) {
      /*
       * п.3: текст остаётся, ключ остаётся, черновик остаётся. Повторное
       * нажатие отправит тот же ключ — дубля не будет.
       */
      setError(
        err instanceof Error
          ? `${err.message}. Текст сохранён — можно отправить ещё раз.`
          : "Заметка не сохранена. Текст сохранён — можно отправить ещё раз.",
      );
      writeDraft(client.id, body);
    } finally {
      setSending(false);
    }
  }

  /* -------------------------------------------------------------- голос */
  const stopAll = useCallback(() => {
    recognitionRef.current?.stop();
    recorderRef.current?.stop();
  }, []);

  async function toggleDictation() {
    if (recording) {
      stopAll();
      return;
    }
    setError(null);

    /* Аудио пишем отдельно от распознавания: STT живёт в браузере,
       а запись нужна, чтобы менеджер мог переслушать сказанное. */
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (chunksRef.current.length === 0) return;
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      };
      recorder.start();
      recorderRef.current = recorder;
    } catch {
      /* Микрофон запрещён — ниже честно скажем об этом, если и STT нет. */
    }

    if (!speechSupported) {
      setRecording(Boolean(recorderRef.current));
      setError(
        recorderRef.current
          ? "Браузер не умеет распознавать речь — запись сохранена, текст наберите вручную."
          : "Диктовка недоступна в этом браузере — наберите текст вручную.",
      );
      return;
    }

    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.lang = "ru-RU";
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      let spoken = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) spoken += ` ${event.results[i][0].transcript}`;
      }
      const text = spoken.trim();
      if (text) {
        setVoiceUsed(true);
        changeBody(body ? `${body} ${text}` : text);
      }
    };
    recognition.onend = () => setRecording(false);
    recognition.onerror = () => {
      setRecording(false);
      setError("Не удалось распознать речь. Запись сохранена — можно переслушать.");
    };
    recognitionRef.current = recognition;
    recognition.start();
    setRecording(true);
  }

  const canSend = Boolean(body.trim()) && Boolean(client) && !sending;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-[var(--muted)]">{label}</span>
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">
          {client ? client.name : "клиент не выбран"}
        </span>
      </div>

      {clientPicker}

      <Field
        label={label === "Новая заметка" ? "Текст заметки" : label}
        hint="Даты «завтра», «в пятницу», «25.11.2026» считаются от времени заметки в вашем часовом поясе."
      >
        <textarea
          ref={areaRef}
          value={body}
          onChange={(event) => changeBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
          }}
          rows={4}
          placeholder="Созвонился с клиентом. Нужно отправить КП завтра. Клиент обещал оплатить счёт до 25.11.2026."
          aria-label="Текст заметки"
          className={`${textareaClass} min-h-[92px] max-h-56 !text-base leading-relaxed`}
        />
      </Field>

      {audioUrl && (
        <div className="rounded-control border border-[var(--border)] bg-[#f8fafd] px-2.5 py-2">
          <p className="mb-1 text-[11.5px] font-medium text-[var(--muted)]">
            Ваша запись — можно переслушать и дописать
          </p>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={audioUrl} className="w-full" />
        </div>
      )}

      {error && (
        <div className="flex flex-wrap items-start justify-between gap-2 rounded-control bg-[var(--danger-soft)] px-2.5 py-2 text-[12.5px] leading-snug text-[var(--danger)]">
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="focus-ring rounded-md px-1.5 py-0.5 text-[12px] font-medium underline decoration-dotted"
          >
            Скрыть
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {/* Вложения и прочие действия клиента — в той же строке, что и запись */}
        {leftSlot}
        <button
          type="button"
          onClick={() => void toggleDictation()}
          title={recording ? "Остановить диктовку" : "Голосовая заметка"}
          aria-label={recording ? "Остановить диктовку" : "Голосовая заметка"}
          aria-pressed={recording}
          className={`focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-control border transition-colors ${
            recording
              ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]"
              : "border-[var(--border-strong)] text-[var(--muted)] hover:border-primary hover:text-primary"
          }`}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          >
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0014 0M12 18v3M8.5 21h7" />
          </svg>
        </button>

        {recording && (
          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--danger)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--danger)]" />
            слушаю
          </span>
        )}

        <div className="flex-1" />

        <span className="mr-1 hidden text-[11.5px] text-[var(--muted)] sm:block">
          {draftSaved ? "черновик сохранён" : "Ctrl+Enter — отправить"}
        </span>

        {rightSlot}

        <Button onClick={() => void submit()} loading={sending} disabled={!canSend} size="md">
          {submitLabel}
        </Button>
      </div>

      {!hideExamples && !body && (
        <div className="flex flex-wrap gap-1.5">
          {[
            "Клиент просит КП до 25.11.2026, обещал оплату по счёту №214 до 05.12.2026.",
            "Позвонил, договорились о встрече в пятницу в 15:00 на объекте.",
          ].map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                changeBody(example);
                areaRef.current?.focus();
              }}
              className="focus-ring max-w-full truncate rounded-full border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--muted)] transition-colors hover:border-primary hover:text-primary"
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
