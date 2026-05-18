import Link from "next/link";

import { Container } from "@/components/layout/container";

const COLUMNS: Array<{
  title: string;
  links: Array<{ href: string; label: string }>;
}> = [
  {
    title: "Fighters",
    links: [
      { href: "/fighters", label: "All fighters" },
      { href: "/events", label: "Events" },
      { href: "/fighters/compare", label: "Compare" },
    ],
  },
  {
    title: "Markets",
    links: [
      { href: "/markets", label: "Open markets" },
      { href: "/me/bets", label: "My bets" },
    ],
  },
  {
    title: "Community",
    links: [
      { href: "/rankings", label: "Rankings" },
      { href: "/leaderboard", label: "Leaderboard" },
    ],
  },
  {
    title: "About",
    links: [
      { href: "/about", label: "About" },
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="mt-16 border-t border-foreground/[0.06] bg-background-elevated/30">
      <Container size="xl" className="py-10 md:py-14">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                {col.title}
              </h4>
              <ul className="mt-3 flex flex-col gap-1.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="font-sans text-sm text-foreground-muted transition-colors hover:text-foreground"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-baseline justify-between gap-3 border-t border-foreground/[0.06] pt-6">
          <p className="font-display text-lg uppercase tracking-widest">
            <span className="text-primary">V</span>
            <span className="text-foreground">ERTEX MMA</span>
          </p>
          <p className="max-w-xl text-right font-sans text-xs text-foreground-subtle">
            UFC scores, community rankings, virtual coin betting. Virtual
            currency has no monetary value. © {new Date().getFullYear()}.
          </p>
        </div>
      </Container>
    </footer>
  );
}
