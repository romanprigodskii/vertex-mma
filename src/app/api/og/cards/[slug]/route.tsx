import { ImageResponse } from "next/og";

import { getFightCardBySlug } from "@/lib/fight-cards";
import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";

// Theme accents are stored as oklch (CSS custom props); Satori needs a plain
// color, so map the five theme ids to hex. Falls back to the brand primary.
const ACCENT_HEX: Record<string, string> = {
  primary: "#e0a33e",
  crimson: "#d6442f",
  azure: "#3b9ae0",
  violet: "#a25ce0",
  emerald: "#34b87a",
};

interface RouteContext {
  params: Promise<{ slug: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { slug } = await ctx.params;
  const card = await getFightCardBySlug(slug);

  if (!card || !card.is_public) {
    return new ImageResponse(<NotFound label="Card not found" />, OG_SIZE);
  }

  const accent = ACCENT_HEX[card.theme_color] ?? OG_COLORS.primary;
  const title = card.title.length > 48 ? `${card.title.slice(0, 48)}…` : card.title;
  const named = card.bouts.filter((b) => b.fighter_a && b.fighter_b);
  const main = named.find((b) => b.is_main) ?? named[0] ?? null;
  const rest = named.filter((b) => b !== main).slice(0, 3);

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: OG_COLORS.bg,
          padding: 60,
          fontFamily: OG_FONTS.sans,
        }}
      >
        {/* accent bar */}
        <div
          style={{ display: "flex", height: 8, width: 120, backgroundColor: accent }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 28 }}>
          <span
            style={{
              color: accent,
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: 6,
              textTransform: "uppercase",
            }}
          >
            VERTEX MMA
          </span>
          <span style={{ color: OG_COLORS.subtle, fontSize: 22 }}>·</span>
          <span
            style={{
              color: OG_COLORS.muted,
              fontSize: 20,
              letterSpacing: 4,
              textTransform: "uppercase",
            }}
          >
            Fight Card
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 28, flex: 1 }}>
          <div
            style={{
              display: "flex",
              fontSize: 68,
              fontWeight: 800,
              color: OG_COLORS.text,
              textTransform: "uppercase",
              letterSpacing: -2,
              lineHeight: 1,
              maxWidth: 1080,
            }}
          >
            {title}
          </div>
          {card.subtitle ? (
            <div style={{ display: "flex", marginTop: 14, color: OG_COLORS.muted, fontSize: 28 }}>
              {card.subtitle.length > 70 ? `${card.subtitle.slice(0, 70)}…` : card.subtitle}
            </div>
          ) : null}

          {main ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 28,
                marginTop: 34,
                padding: "22px 28px",
                backgroundColor: OG_COLORS.bgElev,
                border: `1px solid ${OG_COLORS.border}`,
                borderRadius: 10,
              }}
            >
              <span style={{ fontSize: 40, fontWeight: 700, color: OG_COLORS.text }}>
                {main.fighter_a?.name}
              </span>
              <span style={{ fontSize: 26, color: accent, fontWeight: 700 }}>VS</span>
              <span style={{ fontSize: 40, fontWeight: 700, color: OG_COLORS.text }}>
                {main.fighter_b?.name}
              </span>
            </div>
          ) : null}

          {rest.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", marginTop: 18, gap: 10 }}>
              {rest.map((b, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    color: OG_COLORS.muted,
                    fontSize: 26,
                    fontFamily: OG_FONTS.mono,
                  }}
                >
                  {b.fighter_a?.name} vs {b.fighter_b?.name}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: OG_COLORS.subtle,
            fontSize: 20,
            fontFamily: OG_FONTS.mono,
            letterSpacing: 3,
            textTransform: "uppercase",
          }}
        >
          <span>by @{card.author_username}</span>
          <span>vertexmma.com / cards</span>
        </div>
      </div>
    ),
    OG_SIZE,
  );
}

function NotFound({ label }: { label: string }) {
  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundColor: OG_COLORS.bg,
        color: OG_COLORS.muted,
        fontSize: 48,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: OG_FONTS.sans,
      }}
    >
      {label}
    </div>
  );
}
