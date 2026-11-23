"use client";

/**
 * Онбординг: три подсказки на первом входе.
 * Показываем один раз, если у менеджера ещё нет заметок —
 * опытному пользователю всплывающий тур только мешает.
 */

import { useEffect, useState } from "react";

import { isOnboarded, markOnboarded } from "@/lib/prefs";
import { api } from "@/lib/api";

const STEPS = [
  {
    title: "Напишите заметку",
    text: "Открой «Заметки», выбери клиента и пиши как в мессенджере. Форму из десяти полей заполнять не нужно.",
  },
  {
    title: "AI вытащит задачи",
    text: "Сроки, обещания и тип действия система найдёт сама. Непонятное попадёт в «Уточнить», а не в выдуманный дедлайн.",
  },
  {
    title: "Держи день под контролем",
    text: "На «Сегодня» — просрочки и план. Ctrl+K — быстрый поиск. N — новая заметка, / — клиенты.",
  },
];

export default function Onboarding() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (isOnboarded()) return;
    let cancelled = false;
    // Если уже есть заметки — человек не новичок, тур не нужен.
    api<{ items: unknown[] }>("/notes/feed?limit=1")
      .then((data) => {
        if (cancelled) return;
        if (!data.items?.length) setVisible(true);
        else markOnboarded();
      })
      .catch(() => {
        if (!cancelled) setVisible(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  const current = STEPS[step];

  return (
    <div className="forteon-floating forteon-popover fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md p-4 md:bottom-6 md:right-6 md:left-auto md:mx-0">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-primary">
          Шаг {step + 1} из {STEPS.length}
        </span>
        <button
          type="button"
          onClick={() => {
            markOnboarded();
            setVisible(false);
          }}
          aria-label="Закрыть подсказки"
          className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[#f1f4f9]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <h3 className="text-[16px] font-semibold text-ink">{current.title}</h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--muted)]">{current.text}</p>
      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-5 bg-primary" : "w-1.5 bg-[#cbd5e1]"
              }`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            if (step === STEPS.length - 1) {
              markOnboarded();
              setVisible(false);
            } else setStep(step + 1);
          }}
          className="focus-ring inline-flex h-11 min-h-[44px] items-center rounded-lg bg-primary px-4 text-[13.5px] font-semibold text-white sm:min-h-9"
        >
          {step === STEPS.length - 1 ? "Понятно" : "Дальше"}
        </button>
      </div>
    </div>
  );
}
