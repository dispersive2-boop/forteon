import type { Metadata, Viewport } from "next";

import { AuthProvider } from "@/components/AuthProvider";

import "./globals.css";

export const metadata: Metadata = {
  title: "ForteOn — сопровождение клиентов",
  description:
    "AI-first CRM: заметки → обязательства → задачи → контроль результата → отчёты.",
  applicationName: "ForteOn",
  manifest: "/manifest.webmanifest",
  /**
   * Иконки сгенерированы из реального знака брендбука
   * (backend/_logo_vectorize.py -> logo-mark.svg, icon-192/512, apple-icon).
   * favicon.ico лежит в src/app и подхватывается Next автоматически.
   */
  icons: {
    icon: [
      { url: "/logo-mark.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    shortcut: "/favicon.ico",
  },
  openGraph: {
    title: "ForteOn — сопровождение клиентов",
    description:
      "Заметка превращается в обязательство, задачу и контроль результата.",
    siteName: "ForteOn",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#151B29",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
