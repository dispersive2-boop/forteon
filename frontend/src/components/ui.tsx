"use client";

/** Базовые UI-примитивы ForteOn. Маленькие, без внешних зависимостей. */

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";

import {
  compactMoney,
  isOverdue,
  money,
  PRIORITY_LABELS,
  relativeDay,
  statusLabel,
  TASK_TYPE_LABELS,
} from "@/lib/format";

type ButtonProps = {
  children: React.ReactNode;
  variant?: "primary" | "ghost" | "outline" | "danger" | "subtle";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

const BUTTON_VARIANTS: Record<string, string> = {
  primary:
    "bg-primary text-white hover:bg-[var(--primary-hover)] shadow-soft disabled:bg-[#9db3ee]",
  ghost: "bg-transparent text-[var(--muted)] hover:bg-[#eef2f8] hover:text-ink",
  outline: "border border-[var(--border-strong)] bg-surface text-ink hover:border-primary hover:text-primary",
  danger: "bg-[var(--danger)] text-white hover:brightness-95",
  subtle: "bg-[var(--primary-soft)] text-primary hover:bg-[#dbe7ff]",
};

/*
  п.100 DESIGN TASKS v2.1: активная область не меньше 44x44 CSS px.
  На мобильном поднимаем до 44px; на десктопе оставляем компактный размер,
  иначе плотность рабочего списка падает.
*/
const BUTTON_SIZES: Record<string, string> = {
  sm: "h-11 min-h-[44px] px-3.5 text-[13px] rounded-lg sm:h-9 sm:min-h-9",
  md: "h-11 min-h-[44px] px-4 text-[14.5px] rounded-control",
  lg: "h-12 min-h-[44px] px-6 text-[15.5px] rounded-control",
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`focus-ring relative inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
    >
      {loading && (
        <span className="pointer-events-none absolute h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      <span className={loading ? "inline-flex items-center gap-2 opacity-0" : "inline-flex items-center gap-2"}>{children}</span>
    </button>
  );
}

/**
 * Кнопка-ссылка. Отдельный компонент, потому что `<Link><Button/></Link>`
 * даёт вложенный интерактив: клик по самой кнопке не срабатывает
 * (кнопка перехватывает событие и ничего не делает).
 */
export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "ghost" | "outline" | "danger" | "subtle";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`focus-ring inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap font-medium leading-none transition-colors ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
    >
      {children}
    </Link>
  );
}

export function Card({
  id,
  children,
  className = "",
  padded = true,
}: {
  id?: string;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      id={id}
      className={`rounded-card border border-[var(--border)] bg-surface shadow-soft ${padded ? "p-4" : ""} ${className}`}
    >
      {children}
    </section>
  );
}

export function SectionTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
        {subtitle && <p className="mt-1 text-[13.5px] leading-relaxed text-[var(--muted)]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "primary" | "danger" | "success" | "warning";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-[#eef2f8] text-[var(--muted)]",
    primary: "bg-[var(--primary-soft)] text-primary",
    danger: "bg-[var(--danger-soft)] text-[var(--danger)]",
    success: "bg-[var(--success-soft)] text-[var(--success)]",
    warning: "bg-[var(--warning-soft)] text-[var(--warning)]",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium leading-none ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = useMemo(() => {
    const low = status.toLowerCase();
    if (low.includes("задолж") || low.includes("просроч")) return "danger" as const;
    if (low.includes("работ") || low.includes("договор")) return "primary" as const;
    if (low.includes("архив")) return "neutral" as const;
    if (low.includes("переговор")) return "warning" as const;
    return "neutral" as const;
  }, [status]);
  return <Badge tone={tone}>{statusLabel(status)}</Badge>;
}

export function PriorityDot({ priority }: { priority: string }) {
  const color =
    priority === "critical"
      ? "var(--danger)"
      : priority === "high"
        ? "var(--warning)"
        : priority === "low"
          ? "#9aa7bd"
          : "var(--primary)";
  return <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

export function TaskRow({
  task,
  onComplete,
  compact = false,
}: {
  task: {
    id: string;
    title: string;
    client_name?: string | null;
    due_date: string | null;
    priority: string;
    needs_review: boolean;
    origin: string;
    type: string;
  };
  onComplete?: (id: string) => void;
  compact?: boolean;
}) {
  const overdue = isOverdue({ due_date: task.due_date, status: "open" });
  return (
    <div className="group flex items-start gap-3 rounded-control px-2.5 py-2.5 transition-colors hover:bg-[#f7f9fc]">
      <PriorityDot priority={task.priority} />
      <div className="min-w-0 flex-1">
        <p
          className={`text-[14.5px] leading-snug ${
            overdue ? "font-medium text-[var(--danger)]" : "text-ink"
          }`}
        >
          {task.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-[var(--muted)]">
          {task.client_name && <span className="truncate font-medium">{task.client_name}</span>}
          <span className={overdue ? "font-semibold text-[var(--danger)]" : ""}>
            {relativeDay(task.due_date)}
          </span>
          {task.needs_review && <Badge tone="warning">Уточнить</Badge>}
          {task.origin === "ai" && <Badge tone="primary">AI</Badge>}
          {!compact && task.origin === "import" && <Badge tone="neutral">Импорт</Badge>}
        </div>
      </div>
      {onComplete && (
        <button
          onClick={() => onComplete(task.id)}
          title="Отметить выполненной"
          className="focus-ring mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--border-strong)] text-transparent transition-colors hover:border-[var(--success)] hover:bg-[var(--success-soft)] hover:text-[var(--success)]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  hint,
  tone = "neutral",
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "neutral" | "danger" | "success" | "primary" | "warning";
  href?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "text-ink",
    danger: "text-[var(--danger)]",
    success: "text-[var(--success)]",
    primary: "text-primary",
    warning: "text-[var(--warning)]",
  };
  const body = (
    <div className="rounded-card border border-[var(--border)] bg-surface p-4 shadow-soft transition-shadow hover:shadow-lift">
      <p className="text-[12px] font-semibold uppercase tracking-[0.05em] text-[var(--muted)]">
        {label}
      </p>
      <p
        className={`tabular mt-2 text-[28px] font-semibold leading-none tracking-[-0.02em] ${tones[tone]}`}
      >
        {value}
      </p>
      {hint && <p className="mt-1.5 text-[12.5px] leading-snug text-[var(--muted)]">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="focus-ring block rounded-card">
      {body}
    </Link>
  ) : (
    body
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-[var(--border-strong)] bg-[#fbfcfe] px-6 py-12 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-full bg-[var(--primary-soft)] text-primary">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </div>
      <p className="text-[15.5px] font-semibold text-ink">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-[var(--muted)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function MoneyValue({ value, compact = false }: { value: number | null; compact?: boolean }) {
  return <span>{compact ? compactMoney(value) : money(value)}</span>;
}

export function ProgressBar({ value, tone = "primary" }: { value: number; tone?: "primary" | "success" | "danger" }) {
  const colors: Record<string, string> = {
    primary: "var(--primary)",
    success: "var(--success)",
    danger: "var(--danger)",
  };
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#eef2f8]">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: colors[tone] }}
      />
    </div>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
  footer,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  /*
    Пункты 4-5 списка интерактивности: модалку закрывают Esc и клик по фону.
    Раньше работал только крестик — на телефоне другого выхода не было,
    и при промахе пользователь оставался в форме. Дополнительно блокируем
    прокрутку страницы под оверлеем и переносим фокус в первое поле.
  */
  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    const firstControl = dialog?.querySelector<HTMLElement>(
      "input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])",
    ) ?? dialog?.querySelector<HTMLElement>("button:not([disabled])");
    if (!dialog?.contains(document.activeElement)) firstControl?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-[#0b1220]/45 p-0 sm:items-center sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        // Закрываем только по клику в сам фон, не во вложенный блок.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-1rem)] w-full max-w-lg flex-col rounded-t-2xl border border-[var(--border)] bg-surface shadow-lift sm:rounded-card"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h3 id={titleId} className="text-[14.5px] font-semibold text-ink">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="focus-ring grid h-11 w-11 place-items-center rounded-lg text-[var(--muted)] hover:bg-[#f1f4f9] sm:h-8 sm:w-8"
            aria-label="Закрыть"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
        {footer && <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--border)] px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-[var(--muted)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "focus-ring block h-11 w-full min-w-0 truncate rounded-control border border-[var(--border-strong)] bg-surface px-3.5 text-[14.5px] leading-normal text-ink placeholder:text-[#6B7280]";

export const textareaClass =
  "focus-ring block w-full min-w-0 resize-y rounded-control border border-[var(--border-strong)] bg-surface px-3.5 py-3 text-[14.5px] leading-relaxed text-ink placeholder:text-[#6B7280]";

/* ==================================================================
   Ниже — примитивы для редизайна по списку DESIGN TASKS v2.1.
   Требования: 107 (отступы 4/8/12/16/24/32), 109 (текст 15-16px),
   111 (единые высоты), 113 (hover/focus/pressed/disabled),
   120 (skeleton), 121 (раздельные состояния).
   ================================================================== */

/** Компактная KPI-плашка (п.19: без огромных пустых пространств). */
export function Stat({
  label,
  value,
  tone = "neutral",
  active = false,
  onClick,
}: {
  label: string;
  value: string | number;
  tone?: "neutral" | "danger" | "success" | "primary" | "warning";
  active?: boolean;
  onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    neutral: "text-ink",
    danger: "text-[var(--danger)]",
    success: "text-[var(--success)]",
    primary: "text-primary",
    warning: "text-[#B45309]",
  };
  const body = (
    <>
      <span className={`tabular block text-[22px] font-semibold leading-none tracking-[-0.02em] ${tones[tone]}`}>
        {value}
      </span>
      {/*
        Без truncate: при 390px «Просрочено» обрезалось до «Прос...».
        Разрешаем перенос на две строки — читаемость важнее однострочности
        (п.109 минимальный кегль, п.126 переполнение).
      */}
      <span className="mt-1 block text-[12px] font-medium leading-tight text-[var(--muted)]">
        {label}
      </span>
    </>
  );
  // Внутри flex-контейнера плашка не растягивается на всю строку —
  // на 390px пятая KPI иначе занимала весь ряд (проверено скриншотом).
  const base =
    "w-full min-w-0 rounded-control border px-2.5 py-2.5 text-left transition-colors sm:w-auto sm:min-w-[116px] sm:px-3";
  if (!onClick) {
    return (
      <div className={`${base} border-[var(--border)] bg-surface`}>{body}</div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${base} focus-ring ${
        active
          ? "border-primary bg-[var(--primary-soft)]"
          : "border-[var(--border)] bg-surface hover:border-[var(--border-strong)]"
      }`}
    >
      {body}
    </button>
  );
}

/** Горизонтальные вкладки-фильтры (п.20, п.96: скроллится только полоса). */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: { key: T; label: string; count?: number }[];
  value: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  return (
    <div
      className={`-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-0.5 ${className}`}
      role="tablist"
    >
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.key)}
            className={`focus-ring flex h-11 min-h-[44px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13.5px] font-medium transition-colors sm:h-9 sm:min-h-9 ${
              active
                ? "bg-primary text-white"
                : "bg-[#f1f4f9] text-[var(--muted)] hover:bg-[#e6ecf6] hover:text-ink"
            }`}
          >
            {item.label}
            {typeof item.count === "number" && item.count > 0 && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold leading-none ${
                  active ? "bg-white/22 text-white" : "bg-white text-[var(--muted)]"
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Панель инструментов: заголовок + действия, без «прыжков» ширины (п.112). */
export function Toolbar({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-2 gap-y-2 ${className}`}>{children}</div>
  );
}

/** Раздельные состояния (п.121): «нет данных» и «ошибка загрузки» — разные экраны. */
export function ErrorState({
  title = "Не удалось загрузить",
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-[#f3c7cb] bg-[var(--danger-soft)] px-6 py-10 text-center">
      <div className="mb-3 grid h-11 w-11 place-items-center rounded-full bg-white text-[var(--danger)]">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 9v4M12 17h.01" />
          <circle cx="12" cy="12" r="9.2" />
        </svg>
      </div>
      <p className="text-[15px] font-semibold text-[var(--danger)]">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-[#8c3a41]">{description}</p>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="focus-ring mt-4 h-10 rounded-control border border-[var(--danger)] bg-white px-4 text-[13.5px] font-medium text-[var(--danger)] transition-colors hover:bg-[var(--danger)] hover:text-white"
        >
          Повторить
        </button>
      )}
    </div>
  );
}

/** Чип «Уточнить срок» для задач без даты (п.58). */
export function ReviewChip({ reason }: { reason?: string | null }) {
  return (
    <span
      title={reason || "Срок не определён"}
      className="inline-flex items-center gap-1 rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[11.5px] font-medium leading-tight text-[#B45309]"
    >
      Уточнить срок
    </span>
  );
}

/**
 * Строка задачи для «Сегодня».
 * Отличается от TaskRow: настоящий checkbox 44×44 (п.100), явные
 * действия «Перенести» / «Открыть клиента», аккуратное выделение
 * просрочки без красной заливки всей строки (п.28).
 */
export function TaskItem({
  task,
  active = false,
  busy = false,
  onSelect,
  onComplete,
  onReschedule,
}: {
  task: {
    id: string;
    title: string;
    client_id: string;
    client_name?: string | null;
    due_date: string | null;
    due_at: string | null;
    priority: string;
    type: string;
    needs_review: boolean;
    status: string;
    origin: string;
  };
  active?: boolean;
  busy?: boolean;
  onSelect?: () => void;
  onComplete?: () => void;
  onReschedule?: () => void;
}) {
  const overdue = isOverdue({ due_date: task.due_date, status: task.status });
  const time = task.due_at
    ? new Date(task.due_at.endsWith("Z") ? task.due_at : `${task.due_at}Z`).toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className={`group relative flex items-stretch gap-1 rounded-control border transition-colors ${
        active
          ? "border-primary bg-[var(--primary-soft)]"
          : "border-transparent hover:border-[var(--border)] hover:bg-[#f8fafd]"
      }`}
    >
      {/* Просрочка — тонкая полоса слева, а не красная заливка (п.28) */}
      {overdue && (
        <span aria-hidden className="my-2 w-[3px] shrink-0 rounded-full bg-[var(--danger)]" />
      )}

      <button
        type="button"
        onClick={onComplete}
        disabled={busy}
        title="Выполнить задачу"
        aria-label={`Выполнить: ${task.title}`}
        className="focus-ring my-1.5 ml-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[var(--border-strong)] text-transparent transition-colors hover:border-[var(--success)] hover:bg-[var(--success-soft)] hover:text-[var(--success)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent text-[var(--muted)]" />
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </button>

      <button
        type="button"
        onClick={onSelect}
        className="focus-ring min-w-0 flex-1 rounded-control px-2 py-2 text-left"
      >
        <span
          className={`block truncate text-[14.5px] leading-snug ${
            overdue ? "font-medium text-ink" : "text-ink"
          }`}
        >
          {task.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[var(--muted)]">
          {task.client_name && (
            <span className="max-w-[190px] truncate font-medium text-[#475569]">{task.client_name}</span>
          )}
          <span className={overdue ? "font-semibold text-[var(--danger)]" : ""}>
            {time ? `${time} · ` : ""}
            {relativeDay(task.due_date)}
          </span>
          <span className="hidden sm:inline">· {TASK_TYPE_LABELS[task.type] ?? task.type}</span>
          {task.needs_review && <ReviewChip />}
          {task.priority === "critical" && (
            <span className="rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-[11.5px] font-semibold text-[var(--danger)]">
              Критично
            </span>
          )}
          {task.origin === "ai" && (
            <span className="rounded-full bg-[var(--primary-soft)] px-2 py-0.5 text-[11.5px] font-medium text-primary">
              AI
            </span>
          )}
        </span>
      </button>

      {onReschedule && (
        <button
          type="button"
          onClick={onReschedule}
          title="Перенести на другую дату"
          aria-label="Перенести"
          /*
            Пункт 12: на телефоне :hover не срабатывает, поэтому кнопка
            «Перенести» была невидима и недоступна. На узком экране она
            видна всегда, на десктопе появляется при наведении.
          */
          className="focus-ring my-1.5 mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--muted)] opacity-100 transition-colors hover:bg-[#eef2f8] hover:text-ink focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="4.5" width="18" height="16.5" rx="2.5" />
            <path d="M8 2.5v4M16 2.5v4M3 10.5h18" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Строка закрытой задачи: зачёркнуто + дата закрытия (п.25, п.26). */
export function DoneTaskRow({
  task,
  onReopen,
}: {
  task: {
    id: string;
    title: string;
    client_name?: string | null;
    completed_at: string | null;
  };
  onReopen?: () => void;
}) {
  const when = task.completed_at
    ? new Date(task.completed_at.endsWith("Z") ? task.completed_at : `${task.completed_at}Z`)
        .toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-[#f8fafd]">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--success-soft)] text-[var(--success)]">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] text-[var(--muted)] line-through">{task.title}</span>
        <span className="mt-0.5 block truncate text-[11.5px] text-[var(--muted)]">
          {task.client_name ?? ""}
          {when ? `${task.client_name ? " · " : ""}закрыто в ${when}` : ""}
        </span>
      </span>
      {onReopen && (
        <button
          type="button"
          onClick={onReopen}
          className="focus-ring h-11 min-h-[44px] shrink-0 rounded-lg px-2.5 text-[12.5px] font-medium text-primary transition-colors hover:bg-[var(--primary-soft)] sm:h-8 sm:min-h-8"
        >
          Вернуть
        </button>
      )}
    </div>
  );
}

/** Подпись приоритета для контекстной панели. */
export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority] ?? priority;
}
