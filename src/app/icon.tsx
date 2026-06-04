import { ImageResponse } from "next/og";

/**
 * Browser-tab favicon, generated at build time. A bold brand-gold "V" on the
 * dark UI background — matching the "VERTEX" wordmark in the navbar (the "V"
 * there is text-primary, the same gold). Replaces the old triangle .ico so the
 * brand mark is consistent everywhere. Tweak GOLD / BG to restyle.
 */
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

// --color-primary / --color-gold = oklch(0.78 0.15 70) ≈ this gold.
const GOLD = "#F4A437";
const BG = "#0a0b0e";

export default function Icon() {
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
          borderRadius: 7,
          color: GOLD,
          fontSize: 26,
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
