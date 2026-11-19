"use client";

/** Базовые UI-примитивы ForteOn. Маленькие, без внешних зависимостей. */

import Link from "next/link";
import { useMemo } from "react";

import { compactMoney, isOverdue, money, relativeDay, statusLabel } from "@/lib/format";

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

const BUTTON_SIZES: Record<string, string> = {
  sm: "h-9 min-h-9 px-3.5 text-[13px] rounded-lg",
  md: "h-11 min-h-11 px-4 text-[14.5px] rounded-control",
  lg: "h-12 min-h-12 px-6 text-[15.5px] rounded-control",
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
      className={`focus-ring inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap font-medium leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
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
  children,
  className = "",
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
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
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
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
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#0b1220]/45 p-0 sm:items-center sm:p-6">
      <div className="animate-fade-in w-full max-w-lg rounded-t-2xl border border-[var(--border)] bg-surface shadow-lift sm:rounded-card">
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h3 className="text-[14.5px] font-semibold text-ink">{title}</h3>
          <button
            onClick={onClose}
            className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-[var(--muted)] hover:bg-[#f1f4f9]"
            aria-label="Закрыть"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">{footer}</footer>}
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
  "focus-ring block h-11 w-full min-w-0 truncate rounded-control border border-[var(--border-strong)] bg-surface px-3.5 text-[14.5px] leading-normal text-ink placeholder:text-[#94A3B8]";

export const textareaClass =
  "focus-ring block w-full min-w-0 resize-y rounded-control border border-[var(--border-strong)] bg-surface px-3.5 py-3 text-[14.5px] leading-relaxed text-ink placeholder:text-[#94A3B8]";
