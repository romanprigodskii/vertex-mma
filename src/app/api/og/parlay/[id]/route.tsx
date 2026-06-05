import { ImageResponse } from "next/og";

import { formatNumber } from "@/lib/format";
import { OG_CACHE_HEADERS, OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";
import { getParlayById } from "@/lib/sportsbook-data";
import {
  formatOdds,
  isSelectionCode,
  selectionLabelEn,
  type SportsbookSelectionCode,
} from "@/lib/sportsbook";

export const runtime = "nodejs";
export const contentType = "image/png";
export const revalidate = 3600;

interface RouteContext {
  params: Promise<{ id: string }>;
}

const STATUS: Record<string, { label: string; color: string }> = {
  won: { label: "WON", color: "#22c55e" },
  lost: { label: "LOST", color: "#ef4444" },
  void: { label: "VOID", color: OG_COLORS.muted },
  open: { label: "PENDING", color: OG_COLORS.primary },
};

function notFound() {
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
        Parlay not found
      </div>
    ),
    OG_SIZE,
  );
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const p = await getParlayById(id);
  if (!p) return notFound();

  const status = STATUS[p.status] ?? STATUS.open;
  // Clamp the user-controlled display name (≤60 chars) so a long one can't
  // wrap and break the hero layout — mirrors the profile OG route.
  const bettorRaw = p.bettor_display_name || `@${p.bettor_username}`;
  const bettor =
    bettorRaw.length > 28 ? `${bettorRaw.slice(0, 27)}…` : bettorRaw;
  // 5 legs keeps the card within the 630px canvas even with tall rows.
  const shownLegs = p.legs.slice(0, 5);
  // Count from the actually-rendered legs, not the frozen num_legs (a leg's
  // bout can be cascade-deleted by event-merge reconciliation).
  const legCount = p.legs.length;
  const extra = legCount - shownLegs.length;

  const legTick = (s: string): { ch: string; color: string } => {
    if (s === "won") return { ch: "✓", color: "#22c55e" };
    if (s === "lost") return { ch: "✗", color: "#ef4444" };
    if (s === "void") return { ch: "—", color: OG_COLORS.muted };
    return { ch: "·", color: OG_COLORS.subtle };
  };

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: OG_COLORS.bg,
          padding: 56,
          fontFamily: OG_FONTS.sans,
        }}
      >
        {/* Header */}
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
            {legCount}-Leg Parlay
          </span>
          <div style={{ display: "flex", flex: 1 }} />
          <span
            style={{
              color: status.color,
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: 4,
              textTransform: "uppercase",
              border: `2px solid ${status.color}`,
              borderRadius: 8,
              padding: "4px 14px",
            }}
          >
            {status.label}
          </span>
        </div>

        {/* Bettor + combined odds */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 20, marginTop: 24 }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <span
              style={{
                color: OG_COLORS.subtle,
                fontSize: 20,
                fontFamily: OG_FONTS.mono,
                letterSpacing: 2,
              }}
            >
              {bettor}
            </span>
            <span
              style={{
                color: OG_COLORS.text,
                fontSize: 100,
                fontWeight: 800,
                lineHeight: 1,
              }}
            >
              {formatOdds(p.combined_odds)}
              <span style={{ fontSize: 40, color: OG_COLORS.muted }}>×</span>
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
            <span style={{ color: OG_COLORS.subtle, fontSize: 18, fontFamily: OG_FONTS.mono, letterSpacing: 2 }}>
              {formatNumber(p.stake_coins)} → TO WIN
            </span>
            <span style={{ color: OG_COLORS.primary, fontSize: 48, fontWeight: 800 }}>
              {formatNumber(p.potential_payout)}
            </span>
          </div>
        </div>

        {/* Legs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 24, flex: 1 }}>
          {shownLegs.map((leg, i) => {
            const code = isSelectionCode(leg.selection_code)
              ? (leg.selection_code as SportsbookSelectionCode)
              : null;
            const label = code
              ? selectionLabelEn(code, leg.fighter_a_name, leg.fighter_b_name)
              : leg.selection_code;
            const tick = legTick(leg.status);
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  backgroundColor: OG_COLORS.bgElev,
                  borderRadius: 10,
                  padding: "12px 18px",
                }}
              >
                <span style={{ color: tick.color, fontSize: 26, width: 24 }}>{tick.ch}</span>
                <span
                  style={{
                    color: OG_COLORS.text,
                    fontSize: 26,
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </span>
                <span style={{ color: OG_COLORS.muted, fontSize: 24, fontFamily: OG_FONTS.mono }}>
                  {formatOdds(leg.decimal_odds)}
                </span>
              </div>
            );
          })}
          {extra > 0 ? (
            <span style={{ display: "flex", color: OG_COLORS.subtle, fontSize: 22, fontFamily: OG_FONTS.mono, marginTop: 4 }}>
              + {extra} more leg{extra === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        {/* Footer */}
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
          vertexmma.com — build your own parlay
        </div>
      </div>
    ),
    { ...OG_SIZE, headers: OG_CACHE_HEADERS },
  );
}
