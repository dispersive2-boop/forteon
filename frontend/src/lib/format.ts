/** Форматирование значений для интерфейса ForteOn. */

const moneyNumber = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function money(value: number | null | undefined, currency = "RUB"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const symbol = currency === "RUB" ? "₽" : currency;
  const amount = moneyNumber.format(value === 0 ? 0 : value).replace(/,00$/, "");
  return `${amount}\u00a0${symbol}`;
}

export function compactMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)} млн ₽`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(0)} тыс ₽`;
  return `${value} ₽`;
}

export function dateRu(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function dateTimeRu(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value.endsWith("Z") || value.includes("+") ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeDay(value: string | null | undefined): string {
  if (!value) return "без срока";
  const target = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = new Date(target);
  t.setHours(0, 0, 0, 0);
  const diff = Math.round((t.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff === -1) return "вчера";
  if (diff < 0) return `просрочено на ${Math.abs(diff)} дн.`;
  if (diff <= 7) return `через ${diff} дн.`;
  return dateRu(value);
}

export function isOverdue(task: { due_date: string | null; status: string }): boolean {
  if (!task.due_date || task.status !== "open") return false;
  const due = new Date(`${task.due_date}T23:59:59`);
  return due.getTime() < Date.now();
}

/** Размер файла по-человечески: 1536 → «1,5 КБ». */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} МБ`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

export const STATUS_LABELS: Record<string, string> = {
  active: "Активен",
  new: "Новый",
  переговоры: "Переговоры",
  Переговоры: "Переговоры",
  договор: "Договор",
  "в работе": "В работе",
  "работа с задолженностью": "Задолженность",
  архив: "Архив",
  open: "Открыта",
  done: "Выполнена",
  cancelled: "Отменена",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const PRIORITY_LABELS: Record<string, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  critical: "Критичный",
};

export const TASK_TYPE_LABELS: Record<string, string> = {
  call: "Звонок",
  email: "Письмо",
  meeting: "Встреча",
  document: "Документы",
  payment: "Оплата",
  other: "Прочее",
};

export const ORIGIN_LABELS: Record<string, string> = {
  ai: "AI",
  import: "Импорт",
  manual: "Вручную",
};

export function readAmount(text: string): number | null {
  const normalized = text.replace(/\s/g, "").replace(",", ".");
  if (!normalized) return null;
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Введите сумму в рублях, например 125 000,50.");
  }
  return Number(normalized);
}
