import { ImageResponse } from "next/og";

import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";
import { getRankingById } from "@/lib/rankings";

export const runtime = "nodejs";
export const contentType = "image/png";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { id } = await ctx.params;
  const r = await getRankingById(id);

  if (!r) {
    return new ImageResponse(<NotFound label="Ranking not found" />, OG_SIZE);
  }

  const top3 = r.entries.slice(0, 3);
  const remaining = Math.max(0, r.entries.length - 3);
  const title = r.title.length > 60 ? `${r.title.slice(0, 60)}…` : r.title;

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
            Community Ranking
          </span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 40,
            flex: 1,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 72,
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
          <div
            style={{
              display: "flex",
              marginTop: 16,
              color: OG_COLORS.muted,
              fontSize: 28,
              fontFamily: OG_FONTS.mono,
            }}
          >
            by @{r.author_username} · {r.entry_count} fighter
            {r.entry_count === 1 ? "" : "s"}
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              marginTop: 36,
              gap: 14,
            }}
          >
            {top3.map((e) => (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 24,
                  padding: "14px 22px",
                  backgroundColor: OG_COLORS.bgElev,
                  border: `1px solid ${OG_COLORS.border}`,
                  borderRadius: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 40,
                    fontWeight: 700,
                    color: OG_COLORS.subtle,
                    minWidth: 70,
                  }}
                >
                  #{e.position}
                </span>
                <span
                  style={{
                    fontSize: 36,
                    color: OG_COLORS.text,
                    fontWeight: 600,
                  }}
                >
                  {e.fighter_name}
                </span>
              </div>
            ))}
            {remaining > 0 ? (
              <div
                style={{
                  display: "flex",
                  color: OG_COLORS.subtle,
                  fontSize: 22,
                  fontFamily: OG_FONTS.mono,
                  marginLeft: 24,
                }}
              >
                + {remaining} more
              </div>
            ) : null}
          </div>
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
          vertexmma.com / rankings
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
