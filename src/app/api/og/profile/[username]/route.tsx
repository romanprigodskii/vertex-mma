import { ImageResponse } from "next/og";

import { listUserAchievements } from "@/lib/achievements";
import { getUserProfileByUsername } from "@/lib/auth";
import { OG_COLORS, OG_FONTS, OG_SIZE } from "@/lib/og";

export const runtime = "nodejs";
export const contentType = "image/png";

interface RouteContext {
  params: Promise<{ username: string }>;
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
          {profile.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
            <img
              src={profile.avatarUrl}
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
    OG_SIZE,
  );
}
