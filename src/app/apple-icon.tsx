import { ImageResponse } from "next/og";

/**
 * iOS / "add to home screen" icon — the same brand-gold "V" on the dark
 * background as the favicon (src/app/icon.tsx), scaled to Apple's 180px.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const GOLD = "#F4A437";
const BG = "#0a0b0e";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BG,
          color: GOLD,
          fontSize: 130,
          fontWeight: 800,
          fontFamily: "sans-serif",
          lineHeight: 1,
        }}
      >
        V
      </div>
    ),
    { ...size },
  );
}
