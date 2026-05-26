// Shared nav section list. Centralised so the desktop nav, mobile drawer,
// and footer column all stay in sync.

export type NavSection = {
  href: string;
  label: string;
};

export const NAV_SECTIONS: NavSection[] = [
  { href: "/fighters", label: "Fighters" },
  { href: "/events", label: "Events" },
  { href: "/watch", label: "Watch" },
  { href: "/news", label: "News" },
  { href: "/markets", label: "Markets" },
  { href: "/rankings", label: "Rankings" },
  { href: "/cards", label: "Cards" },
  { href: "/leaderboard", label: "Leaderboard" },
];
