import { ImageResponse } from "next/og";

import { getMarketById } from "@/lib/markets";
import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const m = await getMarketById(id);
  if (!m) {
    return new ImageResponse(
      (
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
          Market not found
        </div>
      ),
      OG_SIZE,
    );
  }

  const priceA = m.outcome_a_price;
  const priceB = m.outcome_b_price;
  const aPct = Math.round(priceA * 100);
  const bPct = Math.round(priceB * 100);

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
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              color: OG_COLORS.primary,
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
            Betting Market
          </span>
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 30,
            color: OG_COLORS.subtle,
            fontSize: 22,
            fontFamily: OG_FONTS.mono,
            letterSpacing: 3,
            textTransform: "uppercase",
          }}
        >
          {m.event_name}
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 24,
            fontSize: 72,
            fontWeight: 800,
            color: OG_COLORS.text,
            textTransform: "uppercase",
            letterSpacing: -2,
            lineHeight: 1.05,
            maxWidth: 1080,
          }}
        >
          {m.fighter_a_name}
          <span style={{ color: OG_COLORS.subtle }}>&nbsp;vs&nbsp;</span>
          {m.fighter_b_name}
        </div>

        <div style={{ display: "flex", gap: 24, marginTop: 50, flex: 1 }}>
          <PriceCard
            label={lastName(m.fighter_a_name)}
            pct={aPct}
            winning={priceA >= priceB}
          />
          <PriceCard
            label={lastName(m.fighter_b_name)}
            pct={bPct}
            winning={priceB > priceA}
          />
        </div>

        <div
          style={{
            display: "flex",
            color: OG_COLORS.subtle,
            fontSize: 20,
            fontFamily: OG_FONTS.mono,
            letterSpacing: 3,
            textTransform: "uppercase",
          }}
        >
          vertexmma.com / markets · {m.total_volume.toLocaleString()} vol ·{" "}
          {m.unique_traders} trader{m.unique_traders === 1 ? "" : "s"}
        </div>
      </div>
    ),
    OG_SIZE,
  );
}

function PriceCard({
  label,
  pct,
  winning,
}: {
  label: string;
  pct: number;
  winning: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: 30,
        backgroundColor: OG_COLORS.bgElev,
        border: `2px solid ${winning ? OG_COLORS.primary : OG_COLORS.border}`,
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          color: OG_COLORS.muted,
          fontSize: 22,
          letterSpacing: 4,
          textTransform: "uppercase",
          fontFamily: OG_FONTS.mono,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          color: OG_COLORS.text,
          fontSize: 96,
          fontWeight: 800,
          lineHeight: 1,
          marginTop: 8,
        }}
      >
        {pct}
        <span style={{ fontSize: 48, color: OG_COLORS.muted }}>%</span>
      </div>
    </div>
  );
}
