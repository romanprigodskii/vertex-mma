import { ImageResponse } from "next/og";

import { getBoutById } from "@/lib/bout-detail";
import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const b = await getBoutById(id);
  if (!b) {
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
          Bout not found
        </div>
      ),
      OG_SIZE,
    );
  }

  const winnerName =
    b.winner_id === b.fighter_a.id
      ? b.fighter_a.name_en
      : b.winner_id === b.fighter_b.id
        ? b.fighter_b.name_en
        : null;

  const dateLabel = new Date(b.event.date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

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
            Fight
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
          {b.event.short_name || b.event.name} · {dateLabel}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 40,
            flex: 1,
          }}
        >
          <FighterCol
            name={b.fighter_a.name_en}
            isWinner={b.winner_id === b.fighter_a.id}
          />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              color: OG_COLORS.subtle,
              fontSize: 64,
              fontWeight: 700,
            }}
          >
            VS
          </div>
          <FighterCol
            name={b.fighter_b.name_en}
            isWinner={b.winner_id === b.fighter_b.id}
            align="right"
          />
        </div>

        {b.status === "completed" && (winnerName || b.method) ? (
          <div
            style={{
              display: "flex",
              marginTop: 30,
              color: OG_COLORS.text,
              fontSize: 28,
              fontFamily: OG_FONTS.mono,
              letterSpacing: 3,
              textTransform: "uppercase",
            }}
          >
            {winnerName ? `${winnerName} ` : ""}
            {b.method ? `by ${b.method.replace(/_/g, " ")}` : ""}
            {b.round_finished ? ` · R${b.round_finished}` : ""}
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            color: OG_COLORS.subtle,
            fontSize: 20,
            fontFamily: OG_FONTS.mono,
            letterSpacing: 3,
            textTransform: "uppercase",
            marginTop: 30,
          }}
        >
          vertexmma.com / bouts
        </div>
      </div>
    ),
    OG_SIZE,
  );
}

function FighterCol({
  name,
  isWinner,
  align,
}: {
  name: string;
  isWinner: boolean;
  align?: "right";
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "flex-start",
        maxWidth: 460,
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: 64,
          fontWeight: 800,
          color: isWinner ? OG_COLORS.streakWin : OG_COLORS.text,
          textTransform: "uppercase",
          letterSpacing: -2,
          lineHeight: 1,
          textAlign: align === "right" ? "right" : "left",
        }}
      >
        {name}
      </div>
      {isWinner ? (
        <div
          style={{
            display: "flex",
            marginTop: 14,
            color: OG_COLORS.streakWin,
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontFamily: OG_FONTS.mono,
          }}
        >
          Winner
        </div>
      ) : null}
    </div>
  );
}
