"use client";

/**
 * Иконки ForteOn из утверждённой дизайн-системы.
 * Контурные, stroke-width 1.9, скруглённые концы, viewBox 24×24.
 * Размер задаётся через `size`, цвет — через `currentColor`.
 */

type IconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
};

function Svg({
  size = 20,
  className = "",
  strokeWidth = 1.9,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* ---------------------------------------------------------- навигация */

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 10.5 12 3.5l8.5 7" />
    <path d="M5.5 9.8V20h13V9.8" />
    <path d="M9.8 20v-5.4h4.4V20" />
  </Svg>
);

export const IconToday = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="5" width="17.6" height="15.5" rx="3" />
    <path d="M8 2.8v3.6M16 2.8v3.6M3.2 10h17.6" />
    <path d="M7.8 14h2.6M13.6 14h2.6M7.8 17.4h2.6" />
  </Svg>
);

export const IconPlanner = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="5" width="17.6" height="15.5" rx="3" />
    <path d="M8 2.8v3.6M16 2.8v3.6M3.2 10h17.6" />
    <path d="M8 13.6h3.4M8 17h7" />
  </Svg>
);

export const IconClients = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9.4" cy="8.2" r="3.6" />
    <path d="M2.8 20.2c.5-3.6 3.2-5.6 6.6-5.6s6.1 2 6.6 5.6" />
    <path d="M17.4 5.4a3.1 3.1 0 0 1 0 5.8" />
    <path d="M19.2 14.9c1.5.5 2.4 1.7 2.7 3.3" />
  </Svg>
);

export const IconProjects = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 3.2 7.4 12 11.8l8.8-4.4Z" />
    <path d="m3.2 12.4 8.8 4.4 8.8-4.4" />
    <path d="m3.2 16.8 8.8 4.4 8.8-4.4" />
  </Svg>
);

export const IconContracts = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3H7.2A2.2 2.2 0 0 0 5 5.2v13.6A2.2 2.2 0 0 0 7.2 21h9.6a2.2 2.2 0 0 0 2.2-2.2V7.8z" />
    <path d="M14 3v4.8h5" />
    <path d="M8.8 13h6.4M8.8 16.6h4.2" />
  </Svg>
);

export const IconTasks = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.4 7.2 1.8 1.8 3.2-3.4" />
    <path d="m3.4 15.2 1.8 1.8 3.2-3.4" />
    <path d="M11.8 7.4h8.8M11.8 15.4h8.8" />
  </Svg>
);

export const IconNotes = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.2h9.2L20 8v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.2a2 2 0 0 1 2-2Z" />
    <path d="M15 3.2V8h4.8" />
    <path d="M8 12.4h7M8 16h5" />
  </Svg>
);

export const IconAttach = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.4 11.6 12 20a5.2 5.2 0 0 1-7.4-7.4l8.9-8.9a3.5 3.5 0 0 1 4.9 4.9l-8.9 8.9a1.7 1.7 0 0 1-2.5-2.5l8.1-8.1" />
  </Svg>
);

export const IconFinance = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 2.8v18.4" />
    <path d="M16.4 6.4H9.8a2.8 2.8 0 0 0 0 5.6h4.4a2.8 2.8 0 0 1 0 5.6H7.2" />
  </Svg>
);

export const IconReports = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h16" />
    <path d="M6.8 20V12M12 20V6.8M17.2 20v-5.6" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
  </Svg>
);

export const IconAdmin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4 6v6c0 4.4 3.4 8 8 9 4.6-1 8-4.6 8-9V6Z" />
    <path d="m9.4 12 1.9 1.9 3.6-3.7" />
  </Svg>
);

/* ---------------------------------------------------------- действия */

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.6-3.6" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconPen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L19.4 8.6a2.6 2.6 0 0 0-3.7-3.7L4 16.4Z" />
    <path d="m14.6 6.4 3.7 3.7" />
  </Svg>
);

export const IconPenSquare = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 4H5.2A2.2 2.2 0 0 0 3 6.2v12.6A2.2 2.2 0 0 0 5.2 21h12.6a2.2 2.2 0 0 0 2.2-2.2V13" />
    <path d="M17.8 3.6a2.4 2.4 0 0 1 3.4 3.4L12 16.2l-4 1 1-4Z" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9.8 4h4.4M6.4 7l.8 12.2a2 2 0 0 0 2 1.8h5.6a2 2 0 0 0 2-1.8L17.6 7" />
    <path d="M10.4 11v6M13.6 11v6" />
  </Svg>
);

export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 5h17.2l-6.6 8v6.2l-4-2V13Z" />
  </Svg>
);

export const IconSort = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4v16M7 20l-3.2-3.2M7 20l3.2-3.2" />
    <path d="M17 20V4M17 4l-3.2 3.2M17 4l3.2 3.2" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 8.4a6 6 0 1 0-12 0c0 6-2.4 7.2-2.4 7.2h16.8S18 14.4 18 8.4" />
    <path d="M13.8 19.2a2.1 2.1 0 0 1-3.6 0" />
  </Svg>
);

export const IconBellDot = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 8.4a6 6 0 0 0-9.4-4.9" />
    <path d="M6 8.4c0 6-2.4 7.2-2.4 7.2h15.2" />
    <path d="M13.8 19.2a2.1 2.1 0 0 1-3.6 0" />
    <circle cx="18.4" cy="4.6" r="2.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPhone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.6 16.4v2.7a1.9 1.9 0 0 1-2.1 1.9 18.4 18.4 0 0 1-8-2.9 18.2 18.2 0 0 1-5.6-5.6 18.4 18.4 0 0 1-2.9-8.1A1.9 1.9 0 0 1 3.9 2.3h2.7a1.9 1.9 0 0 1 1.9 1.6c.1.9.4 1.8.7 2.6a1.9 1.9 0 0 1-.4 2L7.6 9.7a14.6 14.6 0 0 0 5.6 5.6l1.2-1.2a1.9 1.9 0 0 1 2-.4c.8.3 1.7.6 2.6.7a1.9 1.9 0 0 1 1.6 1.9Z" />
  </Svg>
);

export const IconMail = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.8" y="5" width="18.4" height="14" rx="2.6" />
    <path d="m3.6 6.6 8.4 6 8.4-6" />
  </Svg>
);

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21.2 2.8 10.6 13.4" />
    <path d="M21.2 2.8 14.6 21.2l-4-7.8-7.8-4Z" />
  </Svg>
);

export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="2.6" width="6" height="11.2" rx="3" />
    <path d="M5.2 11.2a6.8 6.8 0 0 0 13.6 0" />
    <path d="M12 18v3.4" />
  </Svg>
);

export const IconWave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 10.4v3.2M7 7.6v8.8M10.6 4.8v14.4M14.2 8v8M17.8 6.2v11.6M21.4 10.4v3.2" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.4v11.4M12 14.8 7.6 10.4M12 14.8l4.4-4.4" />
    <path d="M4 17.6v1.4a2.4 2.4 0 0 0 2.4 2.4h11.2a2.4 2.4 0 0 0 2.4-2.4v-1.4" />
  </Svg>
);

export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20.6V9.2M12 9.2 7.6 13.6M12 9.2l4.4 4.4" />
    <path d="M4 6.4V5a2.4 2.4 0 0 1 2.4-2.4h11.2A2.4 2.4 0 0 1 20 5v1.4" />
  </Svg>
);

export const IconImage = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="4.2" width="17.6" height="15.6" rx="2.8" />
    <circle cx="8.8" cy="9.6" r="1.8" />
    <path d="m4.4 17.4 4.8-4.6 3.4 3 3-2.6 4 4" />
  </Svg>
);

export const IconFile = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.6 2.8H7.4a2.2 2.2 0 0 0-2.2 2.2v14a2.2 2.2 0 0 0 2.2 2.2h9.2a2.2 2.2 0 0 0 2.2-2.2V7.6Z" />
    <path d="M13.6 2.8v4.8h5.2" />
  </Svg>
);

export const IconBuilding = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="3" width="10" height="18" rx="1.6" />
    <path d="M14 9h5.2a1 1 0 0 1 1 1v11" />
    <path d="M7 7h1.6M11.4 7H13M7 11h1.6M11.4 11H13M7 15h1.6M11.4 15H13" />
    <path d="M3 21h18" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="3.8" />
    <path d="M4.6 20.4c.6-3.7 3.7-5.6 7.4-5.6s6.8 1.9 7.4 5.6" />
  </Svg>
);

export const IconUsers = IconClients;

export const IconTag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.6 13.4 13 21a2 2 0 0 1-2.8 0L3 13.8V4a1 1 0 0 1 1-1h9.8l6.8 6.8a2 2 0 0 1 0 2.8Z" />
    <circle cx="8.2" cy="8.2" r="1.5" />
  </Svg>
);

export const IconFlag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 21V4" />
    <path d="M5 4.6h11.6l-1.8 3.6 1.8 3.6H5" />
  </Svg>
);

export const IconStar = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.5 6.3 20.5l1.1-6.3L2.8 9.7l6.4-.9Z" />
  </Svg>
);

export const IconStarFilled = (p: IconProps) => (
  <Svg {...p}>
    <path
      d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.5 6.3 20.5l1.1-6.3L2.8 9.7l6.4-.9Z"
      fill="currentColor"
    />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4.4" y="10.4" width="15.2" height="10.4" rx="2.4" />
    <path d="M8 10.4V7.6a4 4 0 0 1 8 0v2.8" />
  </Svg>
);

export const IconCloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.8 18.6h10.4a3.6 3.6 0 0 0 .4-7.2 5.4 5.4 0 0 0-10.4-1.4 3.9 3.9 0 0 0-.4 8.6Z" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.4 11.4a8.4 8.4 0 1 0-2.4 6" />
    <path d="M20.4 5.2v6.2h-6.2" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m20 6.4-11 11-5-5" />
  </Svg>
);

export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.2 2.8 2.8L16.4 9.4" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5.4l3.6 2.2" />
  </Svg>
);

export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.4 4.2 2.6 18a1.9 1.9 0 0 0 1.7 2.8h15.4a1.9 1.9 0 0 0 1.7-2.8L13.6 4.2a1.9 1.9 0 0 0-3.2 0Z" />
    <path d="M12 9.4v4M12 17h.01" />
  </Svg>
);

export const IconX = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);

export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 12H4M10 6l-6 6 6 6" />
  </Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </Svg>
);

export const IconHandshake = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3 12 3.4-3.4a2 2 0 0 1 2.8 0L12 11.4" />
    <path d="m21 12-3.4 3.4a2 2 0 0 1-2.8 0L12 12.6" />
    <path d="M9.2 8.6 12 11.4l2.8-2.8" />
  </Svg>
);

export const IconTruck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6.4h10.4v9.6H3z" />
    <path d="M13.4 9.6h3.6L21 13v3h-7.6" />
    <circle cx="6.6" cy="18.2" r="1.9" />
    <circle cx="17" cy="18.2" r="1.9" />
  </Svg>
);

export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="3.4" width="7" height="7" rx="1.6" />
    <rect x="13.6" y="3.4" width="7" height="7" rx="1.6" />
    <rect x="3.4" y="13.6" width="7" height="7" rx="1.6" />
    <rect x="13.6" y="13.6" width="7" height="7" rx="1.6" />
  </Svg>
);

/* ---------------------------------------------------------- теги задач */

export type TaskTag = {
  key: string;
  label: string;
  icon: (p: IconProps) => React.ReactElement;
  /** Классы фона и цвета из палитры макета */
  className: string;
};

export const TASK_TAGS: TaskTag[] = [
  { key: "call", label: "Звонок", icon: IconPhone, className: "bg-[#EFF6FF] text-[#2563EB]" },
  { key: "payment", label: "Оплата", icon: IconFinance, className: "bg-[#ECFDF5] text-[#22C55E]" },
  { key: "documents", label: "Документы", icon: IconNotes, className: "bg-[#F5F3FF] text-[#7C3AED]" },
  { key: "delivery", label: "Поставка", icon: IconTruck, className: "bg-[#EFF6FF] text-[#3B82F6]" },
  { key: "meeting", label: "Встреча", icon: IconHandshake, className: "bg-[#FFFBEB] text-[#D97706]" },
  { key: "report", label: "Отчёт", icon: IconReports, className: "bg-[#ECFEFF] text-[#06B6D4]" },
  { key: "service", label: "Сервис", icon: IconSettings, className: "bg-[#F1F5F9] text-[#64748B]" },
  { key: "other", label: "Другое", icon: IconGrid, className: "bg-[#F1F5F9] text-[#64748B]" },
];

export const TASK_TAG_MAP = Object.fromEntries(TASK_TAGS.map((t) => [t.key, t]));

/* ---------------------------------------------------------- статусы */

export type StatusTone = {
  label: string;
  className: string;
  icon?: (p: IconProps) => React.ReactElement;
};

export const STATUS_TONES: Record<string, StatusTone> = {
  new: { label: "Новая", className: "bg-[#EFF6FF] text-[#2563EB]", icon: IconPlus },
  in_progress: { label: "В работе", className: "bg-[#EFF6FF] text-[#3B82F6]", icon: IconRefresh },
  done: { label: "Выполнено", className: "bg-[#ECFDF5] text-[#22C55E]", icon: IconCheck },
  overdue: { label: "Просрочено", className: "bg-[#FEF2F2] text-[#EF4444]", icon: IconAlert },
  waiting: { label: "Ожидание", className: "bg-[#FFFBEB] text-[#F59E0B]", icon: IconClock },
  planned: { label: "План", className: "bg-[#F5F3FF] text-[#7C3AED]", icon: IconToday },
  archived: { label: "Архив", className: "bg-[#F1F5F9] text-[#64748B]", icon: IconContracts },
};
