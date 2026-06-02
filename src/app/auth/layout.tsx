import { cookies } from "next/headers";
import { Bebas_Neue, Inter, JetBrains_Mono } from "next/font/google";
import { hasLocale, NextIntlClientProvider } from "next-intl";
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
// its own document shell + intl provider. We honour the NEXT_LOCALE cookie
// (set by next-intl when the user picks a language), so the dominant
// same-device flow — switch to RU, click "forgot password", reset in the same
// browser — stays in the user's language. Falls back to the base locale when
// the cookie is absent or invalid (e.g. a cross-device email click).
export default async function AuthLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  const locale = hasLocale(routing.locales, cookieLocale)
    ? cookieLocale
    : routing.defaultLocale;

  setRequestLocale(locale);
  const messages = await getMessages({ locale });

  return (
    <html
      lang={locale}
      className={`${bebasNeue.variable} ${inter.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background-base text-foreground font-sans antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>{children}</ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
