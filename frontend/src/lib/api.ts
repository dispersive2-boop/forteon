"use client";

/** Клиент API v1 ForteOn. */

/**
 * База API.
 * - production (Caddy, forteon.pro): тот же origin → /api/v1
 * - локальная разработка: NEXT_PUBLIC_API_URL=http://127.0.0.1:8081 → .../api/v1
 *
 * Важно: если страница открыта НЕ с localhost (например, https://forteon.pro),
 * локальный адрес из NEXT_PUBLIC_API_URL игнорируется — иначе браузер
 * посетителя стучался бы в собственный 127.0.0.1. В этом случае используется
 * тот же origin, а разделением /api/* занимается Caddy.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function resolveApiRoot(): string {
  const configured = (process.env.NEXT_PUBLIC_API_URL || "").trim();
  if (!configured) return "";
  if (typeof window === "undefined") return configured;

  const currentHost = window.location.hostname;
  if (LOCAL_HOSTS.has(currentHost)) return configured;

  // Смотрим на хост из настроенного адреса API.
  let apiHost = "";
  try {
    apiHost = new URL(configured).hostname;
  } catch {
    apiHost = "";
  }
  if (LOCAL_HOSTS.has(apiHost)) return "";

  return configured;
}

export const API_ROOT = resolveApiRoot();

const BASE = `${API_ROOT}/api/v1`;

const ACCESS_KEY = "forteon.access";
const REFRESH_KEY = "forteon.refresh";
const USER_KEY = "forteon.user";

export type ApiError = {
  code: string;
  message: string;
  details?: unknown;
  request_id?: string;
};

export class ApiFailure extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(status: number, payload: ApiError) {
    super(payload.message || "Ошибка запроса");
    this.name = "ApiFailure";
    this.status = status;
    this.code = payload.code || "error";
    this.details = payload.details;
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REFRESH_KEY);
}

export type AuthUser = {
  id: string;
  email: string;
  full_name: string;
  role: "manager" | "admin";
  is_active: boolean;
  timezone: string;
  avatar_color: string;
};

export function getUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setSession(access: string, refresh: string, user: AuthUser): void {
  window.localStorage.setItem(ACCESS_KEY, access);
  window.localStorage.setItem(REFRESH_KEY, refresh);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(USER_KEY);
}

async function tryRefresh(): Promise<boolean> {
  const refresh = getRefreshToken();
  if (!refresh) return false;
  try {
    const response = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!response.ok) return false;
    const data = await response.json();
    setSession(data.access_token, data.refresh_token, data.user);
    return true;
  } catch {
    return false;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  raw?: boolean;
  retry?: boolean;
};

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, raw = false, retry = true } = options;
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: payload,
    credentials: "include",
  });

  if (response.status === 401 && retry && (await tryRefresh())) {
    return api<T>(path, { ...options, retry: false });
  }

  if (!response.ok) {
    let error: ApiError = { code: "http_error", message: `HTTP ${response.status}` };
    try {
      const parsed = await response.json();
      error = {
        code: parsed.code || error.code,
        message: parsed.message || parsed.detail?.message || error.message,
        details: parsed.details ?? parsed.detail,
        request_id: parsed.request_id,
      };
    } catch {
      /* пустой ответ */
    }
    throw new ApiFailure(response.status, error);
  }

  if (raw) return (await response.blob()) as unknown as T;
  if (response.status === 204) return undefined as unknown as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const data = await api<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    user: AuthUser;
  }>("/auth/login", { method: "POST", body: { email, password } });
  setSession(data.access_token, data.refresh_token, data.user);
  return data.user;
}

export async function logout(): Promise<void> {
  try {
    await api("/auth/logout", { method: "POST", body: { refresh_token: getRefreshToken() } });
  } finally {
    clearSession();
  }
}

/* ---------------------------------------------------------------- типы домена */

export type Client = {
  id: string;
  owner_id: string;
  type: string;
  name: string;
  legal_name: string | null;
  address: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export type ClientDetail = Client & {
  contacts: {
    id: string;
    name: string;
    position: string | null;
    phone: string | null;
    email: string | null;
    is_primary: boolean;
  }[];
  projects_count: number;
  open_tasks: number;
  overdue_tasks: number;
  debt: number;
};

/** Документ клиента (вкладка «Документы», п.39 §4). */
export type ClientDocument = {
  id: string;
  client_id: string;
  project_id: string | null;
  contract_id: string | null;
  filename: string;
  mime_type: string | null;
  size: number | null;
  created_at: string;
  uploaded_by: string | null;
};

/**
 * Событие истории клиента (A-P0-2).
 * Источник — `audit_log`: фактические действия, а не догадки интерфейса.
 */
export type ClientHistoryEvent = {
  id: string;
  entity: string;
  entity_id: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  actor: string | null;
  created_at: string;
};

/** Договор клиента (вкладка «Проекты» → договоры, п.37 §4). */
export type ClientContract = {
  id: string;
  client_id: string;
  project_id: string | null;
  number: string | null;
  signed_at: string | null;
  amount: number | null;
  currency: string;
  status: string;
};

export type Project = {
  id: string;
  client_id: string;
  name: string;
  location: string | null;
  status: string;
  stage_group: string | null;
  start_date: string | null;
  end_date: string | null;
  planned_revenue: number | null;
  expected_profit?: number | null;
  volume: number | null;
  service_flag: string | null;
  done_before: string | null;
  done_last_sprint: string | null;
  plan_next_sprint: string | null;
  problems_text: string | null;
  meeting_comment: string | null;
};

export type Task = {
  id: string;
  client_id: string;
  client_name: string | null;
  project_id: string | null;
  title: string;
  description: string | null;
  type: string;
  priority: "low" | "normal" | "high" | "critical";
  status: string;
  due_at: string | null;
  due_date: string | null;
  origin: "manual" | "ai" | "import";
  /** Ссылка на заметку, из которой AI создал задачу (п.57 §5). */
  source_note_id: string | null;
  source_quote: string | null;
  confidence: number | null;
  conditional: boolean;
  needs_review: boolean;
  review_reason: string | null;
  /**
   * P0 AI Task Extraction 2.0.
   * event_kind: done | todo | waiting | unclear — что это за событие.
   * actor: us | client — на чьей стороне действие.
   * review_question: конкретный вопрос менеджеру, если тип неясен.
   */
  event_kind?: "done" | "todo" | "waiting" | "unclear";
  actor?: "us" | "client";
  review_question?: string | null;
  assignee_id?: string;
  timezone?: string;
  completed_at: string | null;
  result_note?: string | null;
  version: number;
};

/**
 * Задача как чат: карточка задачи + весь разговор-заметки по клиенту.
 * Один запрос вместо трёх — лента и задача не разъезжаются.
 */
export type TaskChatNote = {
  id: string;
  body: string;
  source_type: string;
  ai_status: string;
  created_at: string;
  author_name?: string | null;
  /** true, если из этой заметки родилась живая задача */
  spawned_task: boolean;
};

export type TaskChat = {
  task: Task;
  client: { id: string; name: string; status: string; type: string };
  notes: TaskChatNote[];
  has_more: boolean;
  next_before: string | null;
};

export type Planner = {
  date_from: string;
  date_to: string;
  overdue: Task[];
  today: Task[];
  week: Task[];
  later: Task[];
  needs_review: Task[];
};

export type PlannerSummary = {
  today: number;
  overdue: number;
  week: number;
  needs_review: number;
  completed_today: number;
};

export type NoteTaskRef = {
  title: string;
  status: string;
};

export type Note = {
  id: string;
  client_id: string;
  project_id: string | null;
  body: string;
  source_type: string;
  ai_status: string;
  ai_error: string | null;
  created_at: string;
  version: number;
  /** Приходит из GET /clients/{id}/notes — во что превратилась заметка */
  client_name?: string | null;
  task_count?: number;
  open_task_count?: number;
  tasks?: NoteTaskRef[];
};

export type FinancialSummary = {
  billed: number;
  paid: number;
  allocated: number;
  debt: number;
  overdue_amount: number;
  currency: string;
  invoices: number;
  unpaid_invoices: number;
};

export type ReportJob = {
  id: string;
  format: "pdf" | "xlsx";
  scope: string;
  client_id: string | null;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type Paged<T> = {
  items: T[];
  total: number;
  next_cursor: string | null;
};

/** Ответ GET /tasks/today — весь экран «Сегодня» одним запросом. */
export type TodayCounters = {
  today: number;
  overdue: number;
  payments: number;
  review: number;
  done_today: number;
  week: number;
};

export type TodayPayload = {
  date: string;
  counters: TodayCounters;
  items: Task[];
  done: Task[];
};

export type Session = {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  device_label: string | null;
  user_agent: string | null;
};

export type NotificationItem = {
  id: string;
  task_id: string | null;
  title: string;
  body: string | null;
  scheduled_at: string;
  read_at: string | null;
};

export type TaskHistoryItem = {
  id: string;
  action: string;
  actor: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type TaskBulkResult = {
  done: number;
  skipped: number;
  action: "complete" | "reopen" | "reschedule";
};
