import { getTranslations } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Link } from "@/i18n/navigation";

type FooterTKey =
  | "fighters"
  | "allFighters"
  | "events"
  | "compare"
  | "markets"
  | "openMarkets"
  | "myBets"
  | "simulation"
  | "community"
  | "predictions"
  | "rankings"
  | "leaderboard"
  | "about"
  | "privacy"
  | "terms";

const COLUMNS: Array<{
  titleKey: FooterTKey;
  links: Array<{ href: string; labelKey: FooterTKey }>;
}> = [
  {
    titleKey: "fighters",
    links: [
      { href: "/fighters", labelKey: "allFighters" },
      { href: "/events", labelKey: "events" },
      { href: "/fighters/compare", labelKey: "compare" },
    ],
  },
  {
    titleKey: "markets",
    links: [
      { href: "/markets", labelKey: "openMarkets" },
      { href: "/simulation", labelKey: "simulation" },
      { href: "/me/bets", labelKey: "myBets" },
    ],
  },
  {
    titleKey: "community",
    links: [
      { href: "/predictions", labelKey: "predictions" },
      { href: "/rankings", labelKey: "rankings" },
      { href: "/leaderboard", labelKey: "leaderboard" },
    ],
  },
  {
    titleKey: "about",
    links: [
      { href: "/about", labelKey: "about" },
      { href: "/privacy", labelKey: "privacy" },
      { href: "/terms", labelKey: "terms" },
    ],
  },
];

export async function Footer() {
  const t = await getTranslations("footer");
  return (
    <footer className="mt-16 border-t border-foreground/[0.06] bg-background-elevated/30">
      <Container size="xl" className="py-10 md:py-14">
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-8 md:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.titleKey} className="min-w-0">
              <h4 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                {t(col.titleKey)}
              </h4>
              <ul className="mt-3 flex flex-col gap-1.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="block break-words font-sans text-sm text-foreground-muted transition-colors hover:text-foreground"
                    >
                      {t(l.labelKey)}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-foreground/[0.06] pt-6 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between">
          <p className="font-display text-lg uppercase tracking-widest">
            <span className="text-primary">V</span>
            <span className="text-foreground">ERTEX MMA</span>
          </p>
          <p className="max-w-xl text-left font-sans text-xs text-foreground-subtle sm:text-right">
            {t("tagline", { year: new Date().getFullYear() })}
          </p>
        </div>
      </Container>
    </footer>
  );
}
