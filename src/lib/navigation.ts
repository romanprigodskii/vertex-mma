// Shared nav section list. Centralised so the desktop nav, mobile drawer,
// and footer column all stay in sync.

export type NavSection = {
  href: string;
  label: string;
};

export const NAV_SECTIONS: NavSection[] = [
  { href: "/fighters", label: "Fighters" },
  { href: "/events", label: "Events" },
  { href: "/markets", label: "Markets" },
  { href: "/rankings", label: "Rankings" },
  { href: "/leaderboard", label: "Leaderboard" },
];
