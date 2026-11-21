"use client";

/**
 * Пользовательские настройки, которые живут в localStorage.
 * Тема и плотность применяются к <html data-theme / data-density>,
 * чтобы Next не мигал светлым при первом рендере (скрипт в layout.tsx).
 */

export type Theme = "light" | "dark" | "system";
export type Density = "cozy" | "compact";

const THEME_KEY = "forteon.theme";
const DENSITY_KEY = "forteon.density";
const ONBOARD_KEY = "forteon.onboarded";

export function getTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const raw = window.localStorage.getItem(THEME_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const dark =
    theme === "dark" || (theme === "system" && systemPrefersDark());
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
  // Мета theme-color, чтобы шапка браузера на телефоне не белела.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0B1220" : "#151B29");
}

export function setTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* приватный режим */
  }
  applyTheme(theme);
}

export function getDensity(): Density {
  if (typeof window === "undefined") return "cozy";
  return window.localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "cozy";
}

export function applyDensity(density: Density): void {
  if (typeof document === "undefined") return;
  if (density === "compact") document.documentElement.dataset.density = "compact";
  else delete document.documentElement.dataset.density;
}

export function setDensity(density: Density): void {
  try {
    window.localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* приватный режим */
  }
  applyDensity(density);
}

export function isOnboarded(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(ONBOARD_KEY) === "1";
}

export function markOnboarded(): void {
  try {
    window.localStorage.setItem(ONBOARD_KEY, "1");
  } catch {
    /* приватный режим */
  }
}
