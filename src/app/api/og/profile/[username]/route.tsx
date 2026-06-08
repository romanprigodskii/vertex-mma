import { ImageResponse } from "next/og";

import { listUserAchievements } from "@/lib/achievements";
import { getUserProfileByUsername } from "@/lib/auth";
import { OG_CACHE_HEADERS, OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";
export const revalidate = 3600;

interface RouteContext {
  params: Promise<{ username: string }>;
}

/** Fetch a remote image and inline it as a data URI, or return null on any
 *  failure (unreachable/slow host, non-2xx, non-image, SVG, empty/oversized).
 *  avatar_url is user-controlled and points at arbitrary external hosts; letting
 *  next/og fetch the <img> during render means a single bad avatar throws inside
 *  Satori and 500s the whole share card for every crawler. Fetching + validating
 *  it here lets a broken avatar degrade to the initials fallback instead. */
async function fetchImageAsDataUri(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim();
    // Raster image only — Satori can't reliably rasterize SVG via <img>, and a
    // non-image body would throw at render time.
    if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
      return null;
    }
    const buffer = await res.arrayBuffer();
    // Skip empties and absurdly large payloads (we inline into the response).
    if (buffer.byteLength === 0 || buffer.byteLength > 3_000_000) return null;
    return `data:${contentType};base64,${Buffer.from(buffer).toString("base64")}`;
  } catch {
    // Unreachable host, abort/timeout, DNS failure, etc.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(_req: Request, ctx: RouteContext) {
  const { username } = await ctx.params;
  const profile = await getUserProfileByUsername(username);
  if (!profile) {
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
          User not found
        </div>
      ),
      OG_SIZE,
    );
  }

  const achievements = await listUserAchievements(profile.userProfileId);
  const displayName = (profile.displayName || profile.username).slice(0, 22);
  const avatarDataUri = profile.avatarUrl
    ? await fetchImageAsDataUri(profile.avatarUrl)
    : null;

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
            Member
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 40,
            marginTop: 60,
            flex: 1,
          }}
        >
          {avatarDataUri ? (
            // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
            <img
              src={avatarDataUri}
              width={220}
              height={220}
              style={{
                borderRadius: 110,
                border: `2px solid ${OG_COLORS.border}`,
                objectFit: "cover",
              }}
            />
          ) : (
            <div
              style={{
                width: 220,
                height: 220,
                borderRadius: 110,
                backgroundColor: OG_COLORS.bgElev,
                color: OG_COLORS.primary,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 88,
                fontWeight: 800,
                textTransform: "uppercase",
              }}
            >
              {profile.username.slice(0, 2)}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: 84,
                fontWeight: 800,
                color: OG_COLORS.text,
                textTransform: "uppercase",
                letterSpacing: -2,
                lineHeight: 1,
              }}
            >
              {displayName}
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 14,
                color: OG_COLORS.muted,
                fontSize: 28,
                fontFamily: OG_FONTS.mono,
              }}
            >
              @{profile.username}
            </div>
            <div
              style={{
                marginTop: 24,
                display: "flex",
                gap: 24,
                color: OG_COLORS.subtle,
                fontSize: 22,
                fontFamily: OG_FONTS.mono,
                letterSpacing: 3,
                textTransform: "uppercase",
              }}
            >
              <span>{profile.tier}</span>
              <span>· {achievements.length} achievements</span>
              <span>· {profile.betCount} bets</span>
            </div>
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
          vertexmma.com / profile / {profile.username}
        </div>
      </div>
    ),
    { ...OG_SIZE, headers: OG_CACHE_HEADERS },
  );
}
