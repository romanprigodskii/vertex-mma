/**
 * Theming registry for user-built fight cards.
 *
 * The `fight_card` row stores `themeColor` / `titleFont` / `backgroundId`
 * as free text. Everything here resolves those strings to concrete render
 * values with a safe fallback, so a hand-edited or stale DB value can never
 * break a page. Plain data + pure functions — safe to import from both
 * client and server components.
 */

export type CardThemeColor = {
  id: string;
  label: string;
  /** Applied as the `--card-accent` custom property on the poster root. */
  accent: string;
};

export const CARD_THEME_COLORS: CardThemeColor[] = [
  { id: "primary", label: "Gold", accent: "oklch(0.78 0.15 70)" },
  { id: "crimson", label: "Crimson", accent: "oklch(0.62 0.22 27)" },
  { id: "azure", label: "Azure", accent: "oklch(0.64 0.15 235)" },
  { id: "violet", label: "Violet", accent: "oklch(0.62 0.2 310)" },
  { id: "emerald", label: "Emerald", accent: "oklch(0.66 0.16 155)" },
];

export type CardThemeFont = {
  id: string;
  label: string;
  className: string;
};

export const CARD_THEME_FONTS: CardThemeFont[] = [
  { id: "sans", label: "Sans", className: "font-sans" },
  { id: "mono", label: "Mono", className: "font-mono" },
];

export type CardThemeBackground = {
  id: string;
  label: string;
  /** Tailwind classes for the poster root. */
  className: string;
  /** Inline style for the poster root. May reference `var(--card-accent)`. */
  style: Record<string, string>;
};

export const CARD_THEME_BACKGROUNDS: CardThemeBackground[] = [
  {
    id: "default",
    label: "Flat",
    className: "bg-background-elevated",
    style: {},
  },
  {
    id: "spotlight",
    label: "Spotlight",
    className: "bg-background-elevated",
    style: {
      backgroundImage:
        "radial-gradient(125% 85% at 50% 0%, color-mix(in oklch, var(--card-accent) 24%, transparent), transparent 62%)",
    },
  },
  {
    id: "grid",
    label: "Grid",
    className: "bg-background-elevated",
    style: {
      backgroundImage:
        "linear-gradient(color-mix(in oklch, var(--card-accent) 9%, transparent) 1px, transparent 1px), linear-gradient(90deg, color-mix(in oklch, var(--card-accent) 9%, transparent) 1px, transparent 1px)",
      backgroundSize: "34px 34px",
    },
  },
];

export function resolveThemeColor(
  id: string | null | undefined,
): CardThemeColor {
  return CARD_THEME_COLORS.find((c) => c.id === id) ?? CARD_THEME_COLORS[0];
}

export function resolveThemeFont(id: string | null | undefined): CardThemeFont {
  return CARD_THEME_FONTS.find((f) => f.id === id) ?? CARD_THEME_FONTS[0];
}

export function resolveThemeBackground(
  id: string | null | undefined,
): CardThemeBackground {
  return (
    CARD_THEME_BACKGROUNDS.find((b) => b.id === id) ?? CARD_THEME_BACKGROUNDS[0]
  );
}

/** Weight-class enum values (mirrors the `weight_class` pgEnum). */
export const WEIGHT_CLASSES = [
  "strawweight",
  "flyweight",
  "bantamweight",
  "featherweight",
  "lightweight",
  "welterweight",
  "middleweight",
  "light_heavyweight",
  "heavyweight",
  "catchweight",
  "openweight",
] as const;

export function formatWeightClass(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
