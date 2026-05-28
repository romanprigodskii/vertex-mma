import { Bebas_Neue, Inter, JetBrains_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";

import "../globals.css";

import { ThemeProvider } from "@/components/layout/theme-provider";
import { routing } from "@/i18n/routing";

const bebasNeue = Bebas_Neue({
  variable: "--font-display-bebas",
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-sans-inter",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono-jetbrains",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

// Password-reset / forgot-password links arrive from Supabase emails with
// no locale prefix, so this segment lives outside `[locale]`. It still needs
// its own document shell + intl provider; default to the base locale.
export default async function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  setRequestLocale(routing.defaultLocale);
  const messages = await getMessages();

  return (
    <html
      lang={routing.defaultLocale}
      className={`${bebasNeue.variable} ${inter.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background-base text-foreground font-sans antialiased">
        <NextIntlClientProvider locale={routing.defaultLocale} messages={messages}>
          <ThemeProvider>{children}</ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
