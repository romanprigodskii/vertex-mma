import { ImageResponse } from "next/og";

import { getBoutOgData } from "@/lib/bout-detail";
import { isRuLocale } from "@/lib/i18n-name";
import { OG_CACHE_HEADERS, OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";
export const revalidate = 3600;

/** Canonical result labels for the share card — mirrors the bout page's display
 *  layer (bout-detail.ts DECISION_LABEL) so the image agrees with the page
 *  instead of dumping the raw enum ("by decision unanimous", "by no contest"). */
const METHOD_LABEL: Record<string, string> = {
  ko: "KO",
  tko: "TKO",
  submission: "Submission",
  decision_unanimous: "Unanimous Decision",
  decision_split: "Split Decision",
  decision_majority: "Majority Decision",
  draw: "Draw",
  no_contest: "No Contest",
  dq: "DQ",
};

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const b = await getBoutOgData(id);
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
      // Cache misses too: a shared link to a deleted/non-existent bout would
      // otherwise re-run the loader against the session pooler on every crawler
      // refetch — exactly the cold-origin stampede OG_CACHE_HEADERS guards.
      { ...OG_SIZE, headers: OG_CACHE_HEADERS },
    );
  }

  const isRu = await isRuLocale();

  const winnerName =
    b.winner_id === b.fighter_a_id
      ? b.fighter_a_name
      : b.winner_id === b.fighter_b_id
        ? b.fighter_b_name
        : null;

  // event_date is timestamptz::text ("2026-06-06 00:00:00+00"). Pin it to UTC
  // (matching isBoutBettable) before parsing so the rendered day doesn't drift
  // a day on hosts behind UTC, and format it in the share's locale so the month
  // label matches the localized fighter/event names beside it.
  const dateLabel = new Date(
    b.event_date.slice(0, 19).replace(" ", "T") + "Z",
  ).toLocaleDateString(isRu ? "ru-RU" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
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
          {b.event_short_name || b.event_name} · {dateLabel}
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
            name={b.fighter_a_name}
            isWinner={b.winner_id === b.fighter_a_id}
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
            name={b.fighter_b_name}
            isWinner={b.winner_id === b.fighter_b_id}
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
            {b.method
              ? `by ${METHOD_LABEL[b.method] ?? b.method.replace(/_/g, " ")}`
              : ""}
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
    { ...OG_SIZE, headers: OG_CACHE_HEADERS },
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
