/**
 * Shared palette + sizing for Open Graph image routes (`/api/og/*`).
 *
 * `ImageResponse` JSX accepts inline styles only — no Tailwind classes —
 * so the brand palette lives here, hex-encoded, and every route imports
 * from this single source.
 */

export const OG_COLORS = {
  bg: "#0a0a0a",
  bgElev: "#171717",
  bgElevSoft: "#262626",
  text: "#fafafa",
  muted: "#a3a3a3",
  subtle: "#525252",
  border: "rgba(255,255,255,0.08)",
  primary: "#f59e0b", // warm orange accent — matches MMA energy
  streakWin: "#22c55e",
  streakLoss: "#ef4444",
} as const;

export const OG_SIZE = { width: 1200, height: 630 } as const;

export const OG_FONTS = {
  sans:
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "ui-monospace, Menlo, monospace",
} as const;
