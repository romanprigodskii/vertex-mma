import { ImageResponse } from "next/og";

import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";
import { getSimulationById } from "@/lib/simulations";

export const runtime = "nodejs";
export const contentType = "image/png";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const sim = await getSimulationById(id);
  if (!sim) {
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
          Simulation not found
        </div>
      ),
      OG_SIZE,
    );
  }

  const a = sim.fighter_a;
  const b = sim.fighter_b;
  const pA = sim.result.winProbabilityA;
  const pB = sim.result.winProbabilityB;
  const aWins = pA >= pB;

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
            Simulation
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 36,
            gap: 32,
          }}
        >
          <FighterCol fighter={a} pct={pA} winner={aWins} />
          <div
            style={{
              display: "flex",
              color: OG_COLORS.subtle,
              fontSize: 56,
              fontWeight: 700,
            }}
          >
            VS
          </div>
          <FighterCol
            fighter={b}
            pct={pB}
            winner={!aWins}
            align="right"
          />
        </div>

        <div
          style={{
            display: "flex",
            marginTop: 28,
            padding: "18px 24px",
            backgroundColor: OG_COLORS.bgElev,
            border: `2px solid ${OG_COLORS.primary}`,
            borderRadius: 12,
            color: OG_COLORS.text,
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: -1,
            textTransform: "uppercase",
            flex: 1,
            alignItems: "center",
          }}
        >
          {sim.result.mostLikelyScenario}
        </div>

        <div
          style={{
            display: "flex",
            color: OG_COLORS.subtle,
            fontSize: 20,
            fontFamily: OG_FONTS.mono,
            letterSpacing: 3,
            textTransform: "uppercase",
            marginTop: 24,
          }}
        >
          vertexmma.com / simulator · {sim.result.modelVersion}
        </div>
      </div>
    ),
    OG_SIZE,
  );
}

function FighterCol({
  fighter,
  pct,
  winner,
  align,
}: {
  fighter: {
    name_en: string;
    photo_url: string | null;
    photo_thumbnail_url: string | null;
  };
  pct: number;
  winner: boolean;
  align?: "right";
}) {
  const src = fighter.photo_thumbnail_url ?? fighter.photo_url ?? null;
  const color = winner ? OG_COLORS.streakWin : OG_COLORS.text;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "flex-start",
        maxWidth: 440,
        flex: 1,
      }}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
        <img
          src={src}
          width={140}
          height={140}
          style={{
            borderRadius: 8,
            border: `2px solid ${winner ? OG_COLORS.primary : OG_COLORS.border}`,
            objectFit: "cover",
          }}
        />
      ) : (
        <div
          style={{
            width: 140,
            height: 140,
            borderRadius: 8,
            backgroundColor: OG_COLORS.bgElev,
            border: `2px solid ${OG_COLORS.border}`,
          }}
        />
      )}
      <div
        style={{
          display: "flex",
          marginTop: 12,
          fontSize: 32,
          fontWeight: 800,
          color,
          textTransform: "uppercase",
          letterSpacing: -1,
          lineHeight: 1.05,
          textAlign: align === "right" ? "right" : "left",
        }}
      >
        {fighter.name_en}
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 6,
          fontSize: 64,
          fontWeight: 800,
          color,
          lineHeight: 1,
          fontFamily: OG_FONTS.mono,
        }}
      >
        {pct.toFixed(1)}%
      </div>
    </div>
  );
}
