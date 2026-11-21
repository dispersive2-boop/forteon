"use client";

/**
 * «Помощь» — короткая справка по рабочим сценариям.
 * Пункт §2: пункт меню существует и открывает реальную страницу,
 * а не заглушку (требование 127 — никаких «заглушек под видом функций»).
 */

import Link from "next/link";

const FLOW = [
  {
    title: "1. Заметка",
    text: "Откройте «Заметки», найдите клиента по названию или ИНН и напишите заметку так, как говорите вслух. Форму из десяти полей заполнять не нужно.",
    href: "/notes",
    cta: "К заметкам",
  },
  {
    title: "2. AI разбирает",
    text: "Сервер выделяет задачи, сроки, тип и приоритет. Неоднозначное попадает в «Требуют уточнения», а не превращается в выдуманный дедлайн.",
  },
  {
    title: "3. План на день",
    text: "На экране «Сегодня» видны просроченные и сегодняшние задачи. Чекбокс закрывает задачу, рядом есть отмена и перенос.",
    href: "/today",
    cta: "На «Сегодня»",
  },
  {
    title: "4. Контроль",
    text: "Планировщик показывает день, неделю, месяц и год. В «Финансах» — выставлено, оплачено, долг и просрочка; в «Отчётах» — выгрузка PDF и XLSX.",
    href: "/planner",
    cta: "В планировщик",
  },
];

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-[900px] space-y-4">
      <header>
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.028em] text-ink">
          Помощь
        </h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--muted)]">
          ForteOn — рабочее место менеджера: заметка превращается в задачу, задача — в контроль
          результата. Ниже — четыре шага ежедневной работы.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        {FLOW.map((step) => (
          <section
            key={step.title}
            className="rounded-card border border-[var(--border)] bg-surface p-4 shadow-soft"
          >
            <h2 className="text-[15.5px] font-semibold text-ink">{step.title}</h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--muted)]">{step.text}</p>
            {step.href && (
              <Link
                href={step.href}
                /*
                  Пункт 11: ссылка-действие на телефоне была высотой 22px —
                  попасть пальцем невозможно. Делаем её полноценной кнопкой
                  с зоной 44px, на десктопе оставляем текстовой.
                */
                className="focus-ring mt-3 inline-flex min-h-[44px] items-center rounded-lg text-[13.5px] font-medium text-primary hover:underline sm:min-h-0"
              >
                {step.cta} →
              </Link>
            )}
          </section>
        ))}
      </div>

      <section className="rounded-card border border-[var(--border)] bg-surface p-4 shadow-soft">
        <h2 className="text-[15.5px] font-semibold text-ink">Горячие клавиши и поведение</h2>
        <ul className="mt-2 space-y-1.5 text-[13.5px] leading-relaxed text-[var(--muted)]">
          <li>
            <span className="font-medium text-ink">Tab / Shift+Tab</span> — перемещение по
            интерактивным элементам, у каждого виден фокус.
          </li>
          <li>
            <span className="font-medium text-ink">Esc</span> — закрыть выдвижную панель,
            модалку или подробности задачи.
          </li>
          <li>
            <span className="font-medium text-ink">N</span> — новая заметка.
          </li>
          <li>
            <span className="font-medium text-ink">/</span> — поиск клиентов.
          </li>
          <li>
            <span className="font-medium text-ink">Ctrl+K</span> — командная палитра: разделы,
            клиенты, задачи. Стрелки — выбор, Enter — открыть.
          </li>
          <li>
            На телефоне нижняя панель фиксирована, центральная кнопка открывает голосовую заметку.
          </li>
          <li>
            Необратимые операции (удаление) требуют подтверждения; обычные сохранения показывают
            ненавязчивое подтверждение.
          </li>
        </ul>
      </section>

      <section className="rounded-card border border-[var(--border)] bg-surface p-4 shadow-soft">
        <h2 className="text-[15.5px] font-semibold text-ink">Если что-то не работает</h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--muted)]">
          Экраны различают три состояния: «нет данных», «ошибка загрузки» и «нет доступа».
          При ошибке загрузки нажмите «Повторить» — данные запрашиваются заново, без перезагрузки
          страницы. Технические коды и JSON пользователю не показываются.
        </p>
      </section>
    </div>
  );
}
