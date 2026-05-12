import type { Metadata } from "next";
import { Bebas_Neue, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const bebasNeue = Bebas_Neue({
  variable: "--font-display-bebas",
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-sans-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${bebasNeue.variable} ${inter.variable} ${jetbrainsMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background-base text-foreground font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
