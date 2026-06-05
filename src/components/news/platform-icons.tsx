import * as React from "react";

/** Brand-color background tile + monochrome glyph. Used by SocialEmbed and
 *  PlatformLink. Sized by parent via width/height on the wrapper. */
export type Platform = "instagram" | "twitter" | "x" | "youtube" | "tiktok" | "link";

const TILE_BG: Record<Platform, string> = {
  instagram:
    "linear-gradient(135deg, #833ab4 0%, #fd1d1d 55%, #fcb045 100%)",
  twitter: "#000000",
  x: "#000000",
  youtube: "#ff0033",
  tiktok: "#000000",
  link: "var(--color-background-overlay)",
};

export function PlatformGlyph({ platform }: { platform: Platform }) {
  switch (platform) {
    case "instagram":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.5" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "twitter":
    case "x":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
        </svg>
      );
    case "youtube":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M21.6 7.2c-.2-.9-.9-1.6-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4c-.9.2-1.6.9-1.8 1.8C2 8.8 2 12 2 12s0 3.2.4 4.8c.2.9.9 1.6 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4c.9-.2 1.6-.9 1.8-1.8.4-1.6.4-4.8.4-4.8s0-3.2-.4-4.8zM10 15V9l5.2 3L10 15z" />
        </svg>
      );
    case "tiktok":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.6 6.6a4.7 4.7 0 0 1-3-1.4 4.6 4.6 0 0 1-1.2-2.5h-3.1v12.4a2.6 2.6 0 1 1-2.6-2.6c.3 0 .5 0 .7.1V9.6c-.2 0-.5-.1-.7-.1a5.8 5.8 0 1 0 5.8 5.8V8.7a8 8 0 0 0 4.1 1.1V6.6z" />
        </svg>
      );
    case "link":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
          <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
        </svg>
      );
  }
}

export function platformTileBg(platform: Platform): string {
  return TILE_BG[platform];
}

/** Detect platform from a URL. Defaults to "link" when nothing matches. */
export function detectPlatform(url: string): Platform {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    if (host.endsWith("instagram.com")) return "instagram";
    if (host === "x.com" || host.endsWith(".x.com")) return "x";
    if (host.endsWith("twitter.com")) return "twitter";
    if (host.endsWith("youtube.com") || host === "youtu.be") return "youtube";
    if (host.endsWith("tiktok.com")) return "tiktok";
    return "link";
  } catch {
    return "link";
  }
}

export function platformDisplayName(platform: Platform): string {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "twitter":
      return "Twitter";
    case "x":
      return "X";
    case "youtube":
      return "YouTube";
    case "tiktok":
      return "TikTok";
    case "link":
      return "Link";
  }
}
