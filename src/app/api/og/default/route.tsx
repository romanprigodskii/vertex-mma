import { ImageResponse } from "next/og";

import { OG_CACHE_HEADERS, OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";
export const revalidate = 86400;

// Default brand share card for the home page and static pages (about/privacy/
// terms) — the surfaces that set no per-entity OG image of their own. The root
// layout points og:image / twitter:image here so its `summary_large_image`
// card never renders as bare text.
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          backgroundColor: OG_COLORS.bg,
          padding: 72,
          justifyContent: "space-between",
          fontFamily: OG_FONTS.sans,
        }}
      >
        <span
          style={{
            color: OG_COLORS.primary,
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: 8,
            textTransform: "uppercase",
          }}
        >
          Vertex MMA
        </span>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 88,
              fontWeight: 800,
              color: OG_COLORS.text,
              textTransform: "uppercase",
              letterSpacing: -3,
              lineHeight: 1.02,
              maxWidth: 1000,
            }}
          >
            UFC scores, rankings &amp; betting.
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 28,
              color: OG_COLORS.muted,
              fontSize: 30,
              lineHeight: 1.3,
              maxWidth: 940,
            }}
          >
            A Vertex score for every active UFC fighter, community rankings, and
            virtual-coin betting markets.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            color: OG_COLORS.subtle,
            fontSize: 22,
            fontFamily: OG_FONTS.mono,
            letterSpacing: 3,
            textTransform: "uppercase",
          }}
        >
          vertexmma.com
        </div>
      </div>
    ),
    { ...OG_SIZE, headers: OG_CACHE_HEADERS },
  );
}
