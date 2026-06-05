import { ImageResponse } from "next/og";

import { getMarketById } from "@/lib/markets";
import { OG_CACHE_HEADERS, OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";
export const revalidate = 3600;

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

  const isMethod = m.type === "method";

  const outcomeA = m.outcomes.find((o) => o.order_index === 0);
  const outcomeB = m.outcomes.find((o) => o.order_index === 1);
  const priceA = outcomeA?.current_price ?? 0.5;
  const priceB = outcomeB?.current_price ?? 0.5;

  // For method markets, "top 2" means the two leading outcomes regardless
  // of fighter — that's what the preview should advertise.
  const topMethodOutcomes = isMethod
    ? [...m.outcomes].sort((a, b) => b.current_price - a.current_price).slice(0, 2)
    : [];

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
            {isMethod ? "Method Market" : "Betting Market"}
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
            fontSize: isMethod ? 64 : 72,
            fontWeight: 800,
            color: OG_COLORS.text,
            textTransform: "uppercase",
            letterSpacing: -2,
            lineHeight: 1.05,
            maxWidth: 1080,
          }}
        >
          {isMethod ? (
            "How will it end?"
          ) : (
            <>
              {m.fighter_a_name}
              <span style={{ color: OG_COLORS.subtle }}>&nbsp;vs&nbsp;</span>
              {m.fighter_b_name}
            </>
          )}
        </div>

        {isMethod ? (
          <div
            style={{
              display: "flex",
              marginTop: 12,
              color: OG_COLORS.muted,
              fontSize: 28,
              fontFamily: OG_FONTS.mono,
            }}
          >
            {m.fighter_a_name} vs {m.fighter_b_name}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 24, marginTop: isMethod ? 32 : 50, flex: 1 }}>
          {isMethod ? (
            topMethodOutcomes.map((o, i) => (
              <PriceCard
                key={o.order_index}
                label={o.label}
                pct={Math.round(o.current_price * 100)}
                winning={i === 0}
                compact
              />
            ))
          ) : (
            <>
              <PriceCard
                label={lastName(m.fighter_a_name)}
                pct={Math.round(priceA * 100)}
                winning={priceA >= priceB}
              />
              <PriceCard
                label={lastName(m.fighter_b_name)}
                pct={Math.round(priceB * 100)}
                winning={priceB > priceA}
              />
            </>
          )}
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
    { ...OG_SIZE, headers: OG_CACHE_HEADERS },
  );
}

function PriceCard({
  label,
  pct,
  winning,
  compact,
}: {
  label: string;
  pct: number;
  winning: boolean;
  compact?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: compact ? 24 : 30,
        backgroundColor: OG_COLORS.bgElev,
        border: `2px solid ${winning ? OG_COLORS.primary : OG_COLORS.border}`,
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          color: OG_COLORS.muted,
          fontSize: compact ? 18 : 22,
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
          fontSize: compact ? 72 : 96,
          fontWeight: 800,
          lineHeight: 1,
          marginTop: 8,
        }}
      >
        {pct}
        <span style={{ fontSize: compact ? 36 : 48, color: OG_COLORS.muted }}>%</span>
      </div>
    </div>
  );
}
