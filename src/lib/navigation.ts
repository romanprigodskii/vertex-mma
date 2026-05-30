// Shared nav section list. Centralised so the desktop nav, mobile drawer,
// and footer column all stay in sync. `labelKey` is the path inside the
// `nav.*` namespace of our messages files — translated at render time.

export type NavSection = {
  href: string;
  labelKey:
    | "fighters"
    | "events"
    | "news"
    | "markets"
    | "simulation"
    | "rankings"
    | "cards"
    | "leaderboard";
};

export const NAV_SECTIONS: NavSection[] = [
  { href: "/fighters", labelKey: "fighters" },
  { href: "/events", labelKey: "events" },
  { href: "/news", labelKey: "news" },
  { href: "/markets", labelKey: "markets" },
  { href: "/simulation", labelKey: "simulation" },
  { href: "/rankings", labelKey: "rankings" },
  { href: "/cards", labelKey: "cards" },
  { href: "/leaderboard", labelKey: "leaderboard" },
];
