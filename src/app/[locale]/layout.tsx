import type { Metadata } from "next";
import { Bebas_Neue, Inter, JetBrains_Mono, Oswald } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";

import "../globals.css";

import { ScrollToTopOnNav } from "@/components/layout/scroll-to-top-on-nav";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { BetSlipProvider } from "@/components/markets/bet-slip-context";
import { BetSlipWidget } from "@/components/markets/bet-slip-widget";
import { FighterSearchPalette } from "@/components/search/fighter-search-palette";
import { routing } from "@/i18n/routing";

const bebasNeue = Bebas_Neue({
  variable: "--font-display-bebas",
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

// Bebas Neue has no Cyrillic glyphs, so RU display headings fell back to a plain
// sans. Oswald is a condensed display face that covers Cyrillic — used only as a
// per-glyph fallback in the --font-display stack, so Latin still renders in Bebas.
const oswald = Oswald({
  variable: "--font-display-oswald",
  weight: "400",
  subsets: ["latin", "cyrillic"],
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

export const metadata: Metadata = {
  // Without this, every relative og:image (/api/og/...) resolves against
  // localhost:3000 in production, so social crawlers can't fetch the cards.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://vertexmma.com",
  ),
  title: {
    default: "Vertex MMA — AI-powered Fight Simulator",
    template: "%s | Vertex MMA",
  },
  description:
    "AI-powered MMA fight simulator. Run any matchup, predict any fight.",
  openGraph: {
    title: "Vertex MMA",
    description: "AI-powered MMA fight simulator",
    siteName: "Vertex MMA",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Vertex MMA",
    description: "AI-powered MMA fight simulator",
  },
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function RootLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  // Hint next-intl/server about the active locale so RSC-level
  // useTranslations / getTranslations resolve correctly.
  setRequestLocale(locale);

  return (
    <html
      lang={locale}
      className={`${bebasNeue.variable} ${oswald.variable} ${inter.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background-base text-foreground font-sans antialiased">
        <NextIntlClientProvider>
          <ThemeProvider>
            <ScrollToTopOnNav />
            <FighterSearchPalette />
            <BetSlipProvider>
              {children}
              <BetSlipWidget />
            </BetSlipProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
