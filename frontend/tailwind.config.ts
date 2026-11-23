import type { Config } from "tailwindcss";

/**
 * ForteOn · дизайн-система.
 *
 * Важно: Tailwind поддерживает только значения прозрачности из шкалы
 * 0,5,10,20,25,30,40,50,60,70,75,80,90,95,100. Классы вида `text-white/62`
 * без расширения шкалы просто НЕ генерируются — элемент наследует цвет
 * родителя, и на тёмном фоне получается тёмный текст на тёмном.
 * Поэтому нужные промежуточные значения добавлены в `opacity`.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      opacity: {
        4: "0.04",
        6: "0.06",
        8: "0.08",
        12: "0.12",
        14: "0.14",
        16: "0.16",
        18: "0.18",
        35: "0.35",
        45: "0.45",
        55: "0.55",
        62: "0.62",
        65: "0.65",
        72: "0.72",
        85: "0.85",
      },
      colors: {
        sidebar: "var(--sidebar)",
        primary: "var(--primary)",
        canvas: "var(--canvas)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        muted: "var(--muted)",
        danger: "var(--danger)",
        success: "var(--success)",
        border: "var(--border)",
      },
      borderRadius: {
        card: "14px",
        control: "10px",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(23,32,51,0.06), 0 8px 24px -12px rgba(23,32,51,0.18)",
        lift: "0 12px 32px -16px rgba(23,32,51,0.32)",
      },
      fontFamily: {
        sans: ["var(--font-ui)"],
      },
      /* Читаемая типографика вместо 11-13px */
      fontSize: {
        "2xs": ["12px", { lineHeight: "1.45" }],
        xs: ["13px", { lineHeight: "1.5" }],
        sm: ["14px", { lineHeight: "1.55" }],
        base: ["15px", { lineHeight: "1.6" }],
        md: ["16px", { lineHeight: "1.55" }],
        lg: ["17px", { lineHeight: "1.5" }],
        xl: ["19px", { lineHeight: "1.4" }],
        "2xl": ["22px", { lineHeight: "1.3" }],
        "3xl": ["27px", { lineHeight: "1.22" }],
        "4xl": ["34px", { lineHeight: "1.16" }],
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-500px 0" },
          "100%": { backgroundPosition: "500px 0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.24s ease-out both",
        shimmer: "shimmer 1.4s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
